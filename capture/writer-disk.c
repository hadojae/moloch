/******************************************************************************/
/* writer-disk.c  -- Default pcap disk writer
 *
 * Copyright 2012-2015 AOL Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this Software except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
#define _FILE_OFFSET_BITS 64
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include "moloch.h"
#include <gio/gio.h>

#ifndef O_NOATIME
#define O_NOATIME 0
#endif

extern MolochConfig_t        config;


typedef struct moloch_output {
    struct moloch_output *mo_next, *mo_prev;
    uint16_t   mo_count;

    char      *name;
    char      *buf;
    uint64_t   max;
    uint64_t   pos;
    char       close;
} MolochDiskOutput_t;


static MolochDiskOutput_t   *output;

static MolochDiskOutput_t    outputQ;
static pthread_mutex_t       outputQMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t        outputQCond = PTHREAD_COND_INITIALIZER;

static MolochIntHead_t       freeOutputBufs;
static pthread_mutex_t       freeOutputMutex = PTHREAD_MUTEX_INITIALIZER;

static uint32_t              outputId;
static char                 *outputFileName;
static uint64_t              outputFilePos = 0;
static struct timeval        outputFileTime;

#define MOLOCH_WRITE_NORMAL 0x00
#define MOLOCH_WRITE_DIRECT 0x01 
#define MOLOCH_WRITE_MMAP   0x02
#define MOLOCH_WRITE_THREAD 0x04

static int                   writeMethod;
static int                   pageSize;

/******************************************************************************/
uint32_t writer_disk_queue_length_thread()
{
    pthread_mutex_lock(&outputQMutex);
    int count = DLL_COUNT(mo_, &outputQ);
    pthread_mutex_unlock(&outputQMutex);
    return count;
}
/******************************************************************************/
uint32_t writer_disk_queue_length_nothread()
{
    return DLL_COUNT(mo_, &outputQ);
}
/******************************************************************************/
void writer_disk_alloc_buf(MolochDiskOutput_t *out)
{
    if (writeMethod & MOLOCH_WRITE_THREAD)
        pthread_mutex_lock(&freeOutputMutex);

    if (freeOutputBufs.i_count > 0) {
        MolochInt_t *tmp;
        DLL_POP_HEAD(i_, &freeOutputBufs, tmp);
        out->buf = (void*)tmp;
    } else {
        out->buf = mmap (0, config.pcapWriteSize + 8192, PROT_READ|PROT_WRITE, MAP_ANON|MAP_PRIVATE, -1, 0);
    }

    if (writeMethod & MOLOCH_WRITE_THREAD)
        pthread_mutex_unlock(&freeOutputMutex);
}
/******************************************************************************/
void writer_disk_free_buf(MolochDiskOutput_t *out)
{
    if (writeMethod & MOLOCH_WRITE_THREAD)
        pthread_mutex_lock(&freeOutputMutex);

    if (freeOutputBufs.i_count > (int)config.maxFreeOutputBuffers) {
        munmap(out->buf, config.pcapWriteSize + 8192);
    } else {
        MolochInt_t *tmp = (MolochInt_t *)out->buf;
        DLL_PUSH_HEAD(i_, &freeOutputBufs, tmp);
    }
    out->buf = 0;

    if (writeMethod & MOLOCH_WRITE_THREAD)
        pthread_mutex_unlock(&freeOutputMutex);
}
/******************************************************************************/
gboolean writer_disk_output_cb(gint fd, GIOCondition UNUSED(cond), gpointer UNUSED(data))
{
    if (config.exiting && fd)
        return FALSE;

    static int outputFd = 0;

    MolochDiskOutput_t *out = DLL_PEEK_HEAD(mo_, &outputQ);
    if (!out)
        return DLL_COUNT(mo_, &outputQ) > 0;

    if (!outputFd) {
        LOG("Opening %s", out->name);
        int options = O_NOATIME | O_WRONLY | O_NONBLOCK | O_CREAT | O_TRUNC;
#ifdef O_DIRECT
        if (writeMethod & MOLOCH_WRITE_DIRECT)
            options |= O_DIRECT;
#endif
        outputFd = open(out->name,  options, S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP);
        if (outputFd < 0) {
            LOG("ERROR - pcap open failed - Couldn't open file: '%s' with %s  (%d)", out->name, strerror(errno), errno);
            if (config.dropUser) {
                LOG("   Verify that user '%s' set by configuration variable dropUser can write and the parent directory exists", config.dropUser);
            }
            exit (2);
        }
    }

    int len;
    if (writeMethod == MOLOCH_WRITE_NORMAL) {
        len = write(outputFd, out->buf+out->pos, (out->max - out->pos));
        if (len < 0) {
            LOG("ERROR - Write %d failed with %d %d\n", outputFd, len, errno);
            exit (0);
        }
    } else {
        int wlen = (out->max - out->pos);
        uint64_t filelen = 0;
        if (out->close && wlen % pageSize != 0) {
            filelen = lseek(outputFd, 0, SEEK_CUR) + wlen;
            wlen = (wlen - (wlen % pageSize) + pageSize);
        }
        len = write(outputFd, out->buf+out->pos, wlen);
        if (len < 0) {
            LOG("ERROR - Write %d failed with %d %d\n", outputFd, len, errno);
            exit (0);
        }
        if (out->close && filelen) {
            (void)ftruncate(outputFd, filelen);
        }
    }

    out->pos += len;

    // Still more to write out
    if (out->pos < out->max) {
        return TRUE;
    }

    // The last write for this fd
    if (out->close) {
        close(outputFd);
        outputFd = 0;
        free(out->name);
    }

    // Cleanup buffer
    writer_disk_free_buf(out);
    DLL_REMOVE(mo_, &outputQ, out);
    MOLOCH_TYPE_FREE(MolochDiskOutput_t, out);

    // More waiting to write on different fd, setup a new watch
    if (outputFd && !config.exiting && DLL_COUNT(mo_, &outputQ) > 0) {
        moloch_watch_fd(outputFd, MOLOCH_GIO_WRITE_COND, writer_disk_output_cb, NULL);
        return FALSE;
    }

    return DLL_COUNT(mo_, &outputQ) > 0;
}
/******************************************************************************/
void *writer_disk_output_thread(void *UNUSED(arg))
{
    MolochDiskOutput_t *out;
    int outputFd = 0;

    while (1) {
        uint64_t filelen = 0;
        pthread_mutex_lock(&outputQMutex);
        while (DLL_COUNT(mo_, &outputQ) == 0) {
            pthread_cond_wait(&outputQCond, &outputQMutex);
        }
        DLL_POP_HEAD(mo_, &outputQ, out);
        pthread_mutex_unlock(&outputQMutex);

        if (!outputFd) {
            LOG("Opening %s", out->name);
            int options = O_NOATIME | O_WRONLY | O_NONBLOCK | O_CREAT | O_TRUNC;
#ifdef O_DIRECT
            if (writeMethod & MOLOCH_WRITE_DIRECT)
                options |= O_DIRECT;
#endif
            outputFd = open(out->name,  options, S_IRUSR | S_IWUSR | S_IRGRP | S_IWGRP);
            if (outputFd < 0) {
                LOG("ERROR - pcap open failed - Couldn't open file: '%s' with %s  (%d)", out->name, strerror(errno), errno);
                exit (2);
            }
        }

        while (out->pos < out->max) {
            int wlen = out->max - out->pos;

            if (out->close && (writeMethod & MOLOCH_WRITE_DIRECT) && ((wlen % pageSize) != 0)) {
                filelen = lseek(outputFd, 0, SEEK_CUR) + wlen;
                wlen = (wlen - (wlen % pageSize) + pageSize);
            }

            int len = write(outputFd, out->buf+out->pos, wlen);
            out->pos += len;
            if (len < 0) {
                LOG("ERROR - Write %d failed with %d %d\n", outputFd, len, errno);
                exit (0);
            }
        }

        if (out->close) {
            if (filelen) {
                (void)ftruncate(outputFd, filelen);
            }
            close(outputFd);
            outputFd = 0;
            free(out->name);
        }
        writer_disk_free_buf(out);
        MOLOCH_TYPE_FREE(MolochDiskOutput_t, out);
    }
}
/******************************************************************************/
void writer_disk_flush(gboolean all)
{
    if (config.dryRun || !output) {
        return;
    }

    output->close = all;
    output->name  = outputFileName;

    MolochDiskOutput_t *noutput = MOLOCH_TYPE_ALLOC0(MolochDiskOutput_t);
    noutput->max = config.pcapWriteSize;
    writer_disk_alloc_buf(noutput);


    all |= (output->pos <= output->max);

    if (all) {
        output->max = output->pos;
    } else {
        noutput->pos = output->pos - output->max;
        memcpy(noutput->buf, output->buf + output->max, noutput->pos);
    }
    output->pos = 0;

    int count;
    if (writeMethod & MOLOCH_WRITE_THREAD) {
        pthread_mutex_lock(&outputQMutex);
        DLL_PUSH_TAIL(mo_, &outputQ, output);
        count = DLL_COUNT(mo_, &outputQ);
        pthread_mutex_unlock(&outputQMutex);
        pthread_cond_broadcast(&outputQCond);
    } else {
        DLL_PUSH_TAIL(mo_, &outputQ, output);
        count = DLL_COUNT(mo_, &outputQ);

        if (count == 1) {
            writer_disk_output_cb(0,0,0);
        }
    }

    if (count >= 100 && count % 50 == 0) {
        LOG("WARNING - %d output buffers waiting, disk IO system too slow?", count);
    }

    output = noutput;
}
/******************************************************************************/
void writer_disk_exit()
{
    moloch_writer_flush(TRUE);
    outputFileName = 0;
    if (writeMethod & MOLOCH_WRITE_THREAD) {
        while (writer_disk_queue_length_thread() >0) {
            usleep(10000);
        }
    } else {
        // Write out all the buffers
        while (DLL_COUNT(mo_, &outputQ) > 0) {
            writer_disk_output_cb(0, 0, 0);
        }
    }
}
/******************************************************************************/
extern struct pcap_file_header pcapFileHeader;
void writer_disk_create(const struct pcap_pkthdr *h)
{
    outputFileName = moloch_db_create_file(h->ts.tv_sec, NULL, 0, 0, &outputId);
    outputFilePos = 24;

    output = MOLOCH_TYPE_ALLOC0(MolochDiskOutput_t);
    output->max = config.pcapWriteSize;
    writer_disk_alloc_buf(output);
    output->pos = 24;
    gettimeofday(&outputFileTime, 0);

    memcpy(output->buf, &pcapFileHeader, 24);
}
/******************************************************************************/
struct pcap_timeval {
    int32_t tv_sec;		/* seconds */
    int32_t tv_usec;		/* microseconds */
};
struct pcap_sf_pkthdr {
    struct pcap_timeval ts;	/* time stamp */
    uint32_t caplen;		/* length of portion present */
    uint32_t len;		/* length this packet (off wire) */
};
void
writer_disk_write(const struct pcap_pkthdr *h, const u_char *sp, uint32_t *fileNum, uint64_t *filePos)
{
    struct pcap_sf_pkthdr hdr;

    hdr.ts.tv_sec  = h->ts.tv_sec;
    hdr.ts.tv_usec = h->ts.tv_usec;
    hdr.caplen     = h->caplen;
    hdr.len        = h->len;

    if (!outputFileName) {
        writer_disk_create(h);
    }

    memcpy(output->buf + output->pos, (char *)&hdr, sizeof(hdr));
    output->pos += sizeof(hdr);

    memcpy(output->buf + output->pos, sp, h->caplen);
    output->pos += h->caplen;

    if(output->pos > output->max) {
        writer_disk_flush(FALSE);
    }
    *fileNum = outputId;
    *filePos = outputFilePos;
    outputFilePos += 16 + h->caplen;

    if (outputFilePos >= config.maxFileSizeB) {
        writer_disk_flush(TRUE);
        outputFileName = 0;
    }
}
/******************************************************************************/
gboolean 
writer_disk_file_time_gfunc (gpointer UNUSED(user_data))
{
    static struct timeval tv;
    gettimeofday(&tv, 0);

    if (outputFileName && outputFilePos > 24 && (tv.tv_sec - outputFileTime.tv_sec) >= config.maxFileTimeM*60) {
        writer_disk_flush(TRUE);
        outputFileName = 0;
    }

    return TRUE;
}

/******************************************************************************/
char *
writer_disk_name () {
    return outputFileName;
}
/******************************************************************************/
void writer_disk_init(char *name)
{
    if (strcmp(name, "normal") == 0)
        writeMethod = MOLOCH_WRITE_NORMAL;
    else if (strcmp(name, "direct") == 0)
        writeMethod = MOLOCH_WRITE_DIRECT;
    else if (strcmp(name, "thread") == 0)
        writeMethod = MOLOCH_WRITE_THREAD | MOLOCH_WRITE_NORMAL;
    else if (strcmp(name, "thread-direct") == 0)
        writeMethod = MOLOCH_WRITE_THREAD | MOLOCH_WRITE_DIRECT;
    else {
        printf("Unknown pcapWriteMethod '%s'\n", name);
        exit(1);
    }

#ifndef O_DIRECT
    if (writeMethod & MOLOCH_WRITE_DIRECT) {
        printf("OS doesn't support direct write method\n");
        exit(1);
    }
#endif

    if (writeMethod & MOLOCH_WRITE_THREAD) {
        g_thread_new("moloch-output", &writer_disk_output_thread, NULL);
    }

    if ((writeMethod & MOLOCH_WRITE_DIRECT) && sizeof(off_t) == 4 && config.maxFileSizeG > 2)
        printf("WARNING - DIRECT mode on 32bit machines may not work with maxFileSizeG > 2");

    pageSize = getpagesize();
    if (writeMethod & MOLOCH_WRITE_DIRECT && (config.pcapWriteSize % pageSize != 0)) {
        printf("When using pcapWriteMethod of direct pcapWriteSize must be a multiple of %d", pageSize);
        exit (1);
    }

    DLL_INIT(mo_, &outputQ);
    DLL_INIT(i_, &freeOutputBufs);

    if (writeMethod & MOLOCH_WRITE_THREAD) {
        moloch_writer_queue_length = writer_disk_queue_length_thread;
    } else {
        moloch_writer_queue_length = writer_disk_queue_length_nothread;
    }

    moloch_writer_flush        = writer_disk_flush;
    moloch_writer_exit         = writer_disk_exit;
    moloch_writer_write        = writer_disk_write;
    moloch_writer_name         = writer_disk_name;

    if (config.maxFileTimeM > 0) {
        g_timeout_add_seconds( 30, writer_disk_file_time_gfunc, 0);
    }
}
