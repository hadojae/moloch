/******************************************************************************/
/* writers.c  -- Functions dealing with writers
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <inttypes.h>
#include <errno.h>
#include <ctype.h>
#include "moloch.h"

MolochWriterQueueLength moloch_writer_queue_length;
MolochWriterWrite moloch_writer_write;
MolochWriterFlush moloch_writer_flush;
MolochWriterExit moloch_writer_exit;
MolochWriterNextInput moloch_writer_next_input;
MolochWriterName moloch_writer_name;

/******************************************************************************/
extern MolochConfig_t        config;

static MolochStringHashStd_t writersHash;

/******************************************************************************/
void moloch_writers_start(char *name) {
    MolochString_t *str;
    if (!name)
        name = moloch_config_str(NULL, "pcapWriteMethod", "thread-direct");


    HASH_FIND(s_, writersHash, name, str);
    if (!str) {
        LOG("Couldn't find pcapWriteMethod %s implementation", name);
        exit(0);
    }
    MolochWriterInit func = str->uw;
    func(name);
}
/******************************************************************************/
void moloch_writers_add(char *name, MolochWriterInit func) {
    moloch_string_add(&writersHash, name, func, TRUE);
}
/******************************************************************************/
void writer_disk_init(char*);
void writer_null_init(char*);
void writer_inplace_init(char*);

void moloch_writers_init()
{
    HASH_INIT(s_, writersHash, moloch_string_hash, moloch_string_cmp);
    moloch_writers_add("null", writer_null_init);
    moloch_writers_add("inplace", writer_inplace_init);
    moloch_writers_add("normal", writer_disk_init);
    moloch_writers_add("direct", writer_disk_init);
    moloch_writers_add("thread", writer_disk_init);
    moloch_writers_add("thread-direct", writer_disk_init);
}
