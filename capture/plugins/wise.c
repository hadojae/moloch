/* wise.c  -- With Intelligence See Everything
 *
 *  Simple plugin that queries the wise service for
 *  ips, domains, email, and md5s which can use various
 *  services to return data.  It caches all the results.
 *
 * Copyright 2012-2014 AOL Inc. All rights reserved.
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
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include "moloch.h"
#include "nids.h"
#include "bsb.h"

extern MolochConfig_t        config;

static void                 *wiseService;

static uint32_t              maxConns;
static uint32_t              maxRequests;
static uint32_t              maxCache;
static uint32_t              cacheSecs;

static int                   httpHostField;
static int                   httpXffField;
static int                   httpMd5Field;
static int                   emailMd5Field;
static int                   emailSrcField;
static int                   emailDstField;
static int                   dnsHostField;
static int                   tagsField;

static uint32_t              fieldsTS;
static int                   fieldsMap[256];

static uint32_t              inflight;

static const int validDNS[256] = {
    ['-'] = 1,
    ['_'] = 1,
    ['a' ... 'z'] = 1,
    ['A' ... 'Z'] = 1,
    ['0' ... '9'] = 1
};

#define INTEL_TYPE_IP      0
#define INTEL_TYPE_DOMAIN  1
#define INTEL_TYPE_MD5     2
#define INTEL_TYPE_EMAIL   3

static char *wiseStrings[] = {"ip", "domain", "md5", "email"};

#define INTEL_STAT_LOOKUP     0
#define INTEL_STAT_CACHE      1
#define INTEL_STAT_REQUEST    2
#define INTEL_STAT_INPROGRESS 3
#define INTEL_STAT_FAIL       4

static uint32_t stats[4][5];
/******************************************************************************/
typedef struct wise_op {
    char                 *str;
    int                   strLenOrInt;
    int                   fieldPos;
} WiseOp_t;

typedef struct wiseitem {
    struct wiseitem      *wih_next, *wih_prev;
    struct wiseitem      *wil_next, *wil_prev;
    uint32_t              wih_bucket;
    uint32_t              wih_hash;

    WiseOp_t             *ops;
    MolochSession_t     **sessions;
    char                 *key;

    uint32_t              loadTime;
    short                 sessionsSize;
    short                 numSessions;
    short                 numOps;
    char                  type;
} WiseItem_t;

typedef struct wiseitem_head {
    struct wiseitem      *wih_next, *wih_prev;
    struct wiseitem      *wil_next, *wil_prev;
    short                 wih_bucket;
    uint32_t              wih_count;
    uint32_t              wil_count;
} WiseItemHead_t;

typedef struct wiserequest {
    BSB          bsb;
    WiseItem_t  *items[256];
    int          numItems;
} WiseRequest_t;

typedef HASH_VAR(h_, WiseItemHash_t, WiseItemHead_t, 199337);

WiseItemHash_t itemHash[4];
WiseItemHead_t itemList[4];

/******************************************************************************/
int wise_item_cmp(const void *keyv, const void *elementv)
{
    char *key = (char*)keyv;
    WiseItem_t *element = (WiseItem_t *)elementv;

    return strcmp(key, element->key) == 0;
}
/******************************************************************************/
void wise_print_stats()
{
    int i;
    for (i = 0; i < 4; i++) {
        LOG("%8s lookups:%7d cache:%7d requests:%7d inprogress:%7d fail:%7d hash:%7d list:%7d",
            wiseStrings[i],
            stats[i][0],
            stats[i][1],
            stats[i][2],
            stats[i][3],
            stats[i][4],
            HASH_COUNT(wih_, itemHash[i]),
            DLL_COUNT(wil_, &itemList[i]));
    }
}
/******************************************************************************/
void wise_load_fields()
{
    char                key[500];
    int                 key_len;

    memset(fieldsMap, -1, sizeof(fieldsMap));

    key_len = snprintf(key, sizeof(key), "/fields");
    size_t         data_len;
    unsigned char *data = moloch_http_send_sync(wiseService, "GET", key, key_len, NULL, 0, NULL, &data_len);;

    BSB bsb;
    BSB_INIT(bsb, data, data_len);

    int ver, cnt = 0;
    BSB_IMPORT_u32(bsb, fieldsTS);
    BSB_IMPORT_u32(bsb, ver);
    BSB_IMPORT_u08(bsb, cnt);

    int i;
    for (i = 0; i < cnt; i++) {
        int len = 0;
        BSB_IMPORT_u16(bsb, len); // len includes NULL terminated
        fieldsMap[i] = moloch_field_define_text((char*)BSB_WORK_PTR(bsb), NULL);
        if (fieldsMap[i] == -1)
            fieldsTS = 0;
        if (config.debug)
            LOG("%d %d %s", i, fieldsMap[i], BSB_WORK_PTR(bsb));
        BSB_IMPORT_skip(bsb, len);
    }
}
/******************************************************************************/
void wise_process_ops(MolochSession_t *session, WiseItem_t *wi)
{
    int i;
    for (i = 0; i < wi->numOps; i++) {
        WiseOp_t *op = &(wi->ops[i]);
        switch (config.fields[op->fieldPos]->type) {
        case  MOLOCH_FIELD_TYPE_INT_HASH:
            if (op->fieldPos == tagsField) {
                moloch_nids_add_tag(session, op->str);
                continue;
            }
            // Fall Thru
        case  MOLOCH_FIELD_TYPE_INT:
        case  MOLOCH_FIELD_TYPE_INT_ARRAY:
        case  MOLOCH_FIELD_TYPE_IP:
        case  MOLOCH_FIELD_TYPE_IP_HASH:
            moloch_field_int_add(op->fieldPos, session, op->strLenOrInt);
            break;
        case  MOLOCH_FIELD_TYPE_STR:
        case  MOLOCH_FIELD_TYPE_STR_ARRAY:
        case  MOLOCH_FIELD_TYPE_STR_HASH:
            moloch_field_string_add(op->fieldPos, session, op->str, op->strLenOrInt, TRUE);
            break;
        }
    }
}
/******************************************************************************/
void wise_free_ops(WiseItem_t *wi)
{
    int i;
    for (i = 0; i < wi->numOps; i++) {
        if (wi->ops[i].str)
            g_free(wi->ops[i].str);
    }
    if (wi->ops)
        g_free(wi->ops);
    wi->numOps = 0;
    wi->ops = NULL;
}
/******************************************************************************/
void wise_free_item(WiseItem_t *wi)
{
    int i;
    HASH_REMOVE(wih_, itemHash[(int)wi->type], wi);
    if (wi->sessions) {
        for (i = 0; i < wi->numSessions; i++) {
            moloch_nids_decr_outstanding(wi->sessions[i]);
        }
        g_free(wi->sessions);
    }
    g_free(wi->key);
    wise_free_ops(wi);
    MOLOCH_TYPE_FREE(WiseItem_t, wi);
}
/******************************************************************************/
void wise_cb(int UNUSED(code), unsigned char *data, int data_len, gpointer uw)
{

    BSB             bsb;
    WiseRequest_t *request = uw;
    int             i;

    inflight -= request->numItems;

    BSB_INIT(bsb, data, data_len);

    uint32_t fts = 0, ver = 0;
    BSB_IMPORT_u32(bsb, fts);
    BSB_IMPORT_u32(bsb, ver);

    if (BSB_IS_ERROR(bsb) || ver != 0) {
        for (i = 0; i < request->numItems; i++) {
            wise_free_item(request->items[i]);
        }
        MOLOCH_TYPE_FREE(WiseRequest_t, request);
        return;
    }

    if (fts != fieldsTS)
        wise_load_fields();

    struct timeval currentTime;
    gettimeofday(&currentTime, NULL);

    for (i = 0; i < request->numItems; i++) {
        WiseItem_t    *wi = request->items[i];
        BSB_IMPORT_u08(bsb, wi->numOps);

        if (wi->numOps > 0) {
            wi->ops = malloc(wi->numOps * sizeof(WiseOp_t));

            int i;
            for (i = 0; i < wi->numOps; i++) {
                WiseOp_t *op = &(wi->ops[i]);

                int rfield = 0;
                BSB_IMPORT_u08(bsb, rfield);
                op->fieldPos = fieldsMap[rfield];

                int len = 0;
                BSB_IMPORT_u08(bsb, len);
                char *str = (char*)BSB_WORK_PTR(bsb);
                BSB_IMPORT_skip(bsb, len);

                switch (config.fields[op->fieldPos]->type) {
                case  MOLOCH_FIELD_TYPE_INT_HASH:
                    if (op->fieldPos == tagsField) {
                        moloch_db_get_tag(NULL, tagsField, str, NULL); // Preload the tagname -> tag mapping
                        op->str = g_strdup(str);
                        op->strLenOrInt = len - 1;
                        continue;
                    }
                    // Fall thru
                case  MOLOCH_FIELD_TYPE_INT:
                case  MOLOCH_FIELD_TYPE_INT_ARRAY:
                    op->str = 0;
                    op->strLenOrInt = atoi(str);
                    break;
                case  MOLOCH_FIELD_TYPE_STR:
                case  MOLOCH_FIELD_TYPE_STR_ARRAY:
                case  MOLOCH_FIELD_TYPE_STR_HASH:
                    op->str = g_strdup(str);
                    op->strLenOrInt = len - 1;
                    break;
                case  MOLOCH_FIELD_TYPE_IP:
                case  MOLOCH_FIELD_TYPE_IP_HASH:
                    op->str = 0;
                    op->strLenOrInt = inet_addr(str);
                    break;
                default:
                    LOG("WARNING - Unsupported expression type for %s", str);
                    continue;
                }
            }
        }

        wi->loadTime = currentTime.tv_sec;

        int s;
        for (s = 0; s < wi->numSessions; s++) {
            wise_process_ops(wi->sessions[s], wi);
            moloch_nids_decr_outstanding(wi->sessions[s]);
        }
        g_free(wi->sessions);
        wi->sessions = 0;
        wi->numSessions = 0;

        DLL_PUSH_HEAD(wil_, &itemList[(int)wi->type], wi);
        // Cache needs to be reduced
        if (itemList[(int)wi->type].wil_count > maxCache) {
            DLL_POP_TAIL(wil_, &itemList[(int)wi->type], wi);
            wise_free_item(wi);
        }
    }
    MOLOCH_TYPE_FREE(WiseRequest_t, request);
}
/******************************************************************************/
void wise_lookup(MolochSession_t *session, WiseRequest_t *request, char *value, int type)
{
    static int lookups = 0;

    if (*value == 0)
        return;

    if (request->numItems >= 256)
        return;

    lookups++;
    if ((lookups % 10000) == 0)
        wise_print_stats();

    stats[type][INTEL_STAT_LOOKUP]++;

    WiseItem_t *wi;
    HASH_FIND(wih_, itemHash[type], value, wi);

    if (wi) {
        // Already being looked up
        if (wi->sessions) {
            if (wi->numSessions < wi->sessionsSize) {
                wi->sessions[wi->numSessions++] = session;
                moloch_nids_incr_outstanding(session);
            }
            stats[type][INTEL_STAT_INPROGRESS]++;
            return;
        }

        struct timeval currentTime;
        gettimeofday(&currentTime, NULL);

        if (wi->loadTime + cacheSecs > currentTime.tv_sec) {
            wise_process_ops(session, wi);
            stats[type][INTEL_STAT_CACHE]++;
            return;
        }

        /* Had it in cache, but it is too old */
        DLL_REMOVE(wil_, &itemList[type], wi);
        wise_free_ops(wi);
    } else {
        // Know nothing about it
        wi = MOLOCH_TYPE_ALLOC0(WiseItem_t);
        wi->key          = g_strdup(value);
        wi->type         = type;
        wi->sessionsSize = 20;
        HASH_ADD(wih_, itemHash[type], wi->key, wi);
    }

    wi->sessions = malloc(sizeof(MolochSession_t *) * wi->sessionsSize);
    wi->sessions[wi->numSessions++] = session;
    moloch_nids_incr_outstanding(session);

    stats[type][INTEL_STAT_REQUEST]++;

    BSB_EXPORT_u08(request->bsb, type);
    int len = strlen(value);
    BSB_EXPORT_u16(request->bsb, len);
    BSB_EXPORT_ptr(request->bsb, value, len);

    request->items[request->numItems++] = wi;
}
/******************************************************************************/
void wise_lookup_domain(MolochSession_t *session, WiseRequest_t *request, char *domain)
{
    unsigned char *end = (unsigned char*)domain;
    unsigned char *colon = 0;
    int            period = 0;

    while (*end) {
        if (!validDNS[*end]) {
            if (*end == '.') {
                period++;
                end++;
                continue;
            }
            if (*end == ':') {
                colon = end;
                *colon = 0;
                break;
            }
            if (config.debug) {
                LOG("Invalid DNS: %s", domain);
            }
            return;
        }
        end++;
    }

    if (period == 0) {
        if (config.debug) {
            LOG("Invalid DNS: %s", domain);
        }
        return;
    }

    // Last character is digit, can't be a domain, so either ip or bogus
    if (isdigit(*(end-1))) {
        struct in_addr addr;
        if (inet_pton(AF_INET, domain, &addr) == 1) {
            wise_lookup(session, request, domain, INTEL_TYPE_IP);
        }
        return;
    }

    wise_lookup(session, request, domain, INTEL_TYPE_DOMAIN);

    if (colon)
        *colon = ':';
}
/******************************************************************************/
void wise_lookup_ip(MolochSession_t *session, WiseRequest_t *request, uint32_t ip)
{
    char ipstr[18];

    snprintf(ipstr, sizeof(ipstr), "%d.%d.%d.%d", ip & 0xff, (ip >> 8) & 0xff, (ip >> 16) & 0xff, (ip >> 24) & 0xff);

    wise_lookup(session, request, ipstr, INTEL_TYPE_IP);
}
/******************************************************************************/
static WiseRequest_t *iRequest = 0;
static char          *iBuf = 0;
/******************************************************************************/
gboolean wise_flush(gpointer UNUSED(user_data))
{
    if (!iRequest || iRequest->numItems == 0)
        return TRUE;

    inflight += iRequest->numItems;
    if (moloch_http_send(wiseService, "POST", "/get", 4, iBuf, BSB_LENGTH(iRequest->bsb), NULL, TRUE, wise_cb, iRequest) != 0) {
        LOG("Wise - request failed %p for %d items", iRequest, iRequest->numItems);
        wise_cb(500, NULL, 0, iRequest);
    }

    iRequest = 0;
    iBuf     = 0;

    return TRUE;
}
/******************************************************************************/

void wise_plugin_pre_save(MolochSession_t *session, int UNUSED(final))
{
    MolochString_t *hstring;

    if (!iRequest) {
        iRequest = MOLOCH_TYPE_ALLOC(WiseRequest_t);
        iBuf = moloch_http_get_buffer(0xffff);
        BSB_INIT(iRequest->bsb, iBuf, 0xffff);
        iRequest->numItems = 0;
    }

    //IPs
    wise_lookup_ip(session, iRequest, session->addr1);
    wise_lookup_ip(session, iRequest, session->addr2);


    //Domains
    if (session->fields[httpHostField]) {
        MolochStringHashStd_t *shash = session->fields[httpHostField]->shash;
        HASH_FORALL(s_, *shash, hstring,
            if (hstring->str[0] == 'h') {
                if (memcmp(hstring->str, "http://", 7) == 0)
                    wise_lookup_domain(session, iRequest, hstring->str+7);
                else if (memcmp(hstring->str, "https://", 8) == 0)
                    wise_lookup_domain(session, iRequest, hstring->str+8);
                else
                    wise_lookup_domain(session, iRequest, hstring->str);
            } else
                wise_lookup_domain(session, iRequest, hstring->str);
        );
    }
    if (session->fields[dnsHostField]) {
        MolochStringHashStd_t *shash = session->fields[dnsHostField]->shash;
        HASH_FORALL(s_, *shash, hstring,
            if (hstring->str[0] == '<')
                continue;
            wise_lookup_domain(session, iRequest, hstring->str);
        );
    }

    //MD5s
    if (session->fields[httpMd5Field]) {
        MolochStringHashStd_t *shash = session->fields[httpMd5Field]->shash;
        HASH_FORALL(s_, *shash, hstring,
            wise_lookup(session, iRequest, hstring->str, INTEL_TYPE_MD5);
        );
    }

    if (session->fields[emailMd5Field]) {
        MolochStringHashStd_t *shash = session->fields[emailMd5Field]->shash;
        HASH_FORALL(s_, *shash, hstring,
            wise_lookup(session, iRequest, hstring->str, INTEL_TYPE_MD5);
        );
    }

    //Email
    if (session->fields[emailSrcField]) {
        MolochStringHashStd_t *shash = session->fields[emailSrcField]->shash;
        HASH_FORALL(s_, *shash, hstring,
            wise_lookup(session, iRequest, hstring->str, INTEL_TYPE_EMAIL);
        );
    }

    if (session->fields[emailDstField]) {
        MolochStringHashStd_t *shash = session->fields[emailDstField]->shash;
        HASH_FORALL(s_, *shash, hstring,
            wise_lookup(session, iRequest, hstring->str, INTEL_TYPE_EMAIL);
        );
    }

    if (iRequest->numItems > 128) {
        wise_flush(0);
    }
}
/******************************************************************************/
void wise_plugin_exit()
{
    moloch_http_free_server(wiseService);
}
/******************************************************************************/
uint32_t wise_plugin_outstanding()
{
    return inflight + (iRequest?iRequest->numItems:0);
}
/******************************************************************************/
void moloch_plugin_init()
{

    if (config.dryRun) {
        LOG("Not enabling in dryRun mode");
        return;
    }

    maxConns = moloch_config_int(NULL, "wiseMaxConns", 10, 1, 60);
    maxRequests = moloch_config_int(NULL, "wiseMaxRequests", 100, 1, 50000);
    maxCache = moloch_config_int(NULL, "wiseMaxCache", 100000, 1, 500000);
    cacheSecs = moloch_config_int(NULL, "wiseCacheSecs", 600, 1, 5000);

    int   port = moloch_config_int(NULL, "wisePort", 8081, 1, 0xffff);
    char *host = moloch_config_str(NULL, "wiseHost", "127.0.0.1");

    if (config.debug) {
        LOG("wise max conns = %d", maxConns);
        LOG("wise max requests = %d", maxRequests);
        LOG("wise max cache = %d", maxCache);
        LOG("wise cache seconds = %d", cacheSecs);
        LOG("wise host = %s", host);
        LOG("wise port = %d", port);
    }

    httpHostField  = moloch_field_by_db("ho");
    httpXffField   = moloch_field_by_db("xff");
    httpMd5Field   = moloch_field_by_db("hmd5");
    emailMd5Field  = moloch_field_by_db("emd5");
    emailSrcField  = moloch_field_by_db("esrc");
    emailDstField  = moloch_field_by_db("edst");
    dnsHostField   = moloch_field_by_db("dnsho");
    tagsField      = moloch_field_by_db("ta");

    wiseService = moloch_http_create_server(host, port, maxConns, maxRequests, 0);

    moloch_plugins_register("wise", FALSE);

    moloch_plugins_set_cb("wise",
      NULL,
      NULL,
      NULL,
      wise_plugin_pre_save,
      NULL,
      NULL,
      wise_plugin_exit,
      NULL
    );

    moloch_plugins_set_outstanding_cb("wise", wise_plugin_outstanding);

    int h;
    for (h = 0; h < 4; h++) {
        HASH_INIT(wih_, itemHash[h], moloch_string_hash, wise_item_cmp);
        DLL_INIT(wil_, &itemList[h]);
    }
    g_timeout_add_seconds( 1, wise_flush, 0);
    wise_load_fields();
}
