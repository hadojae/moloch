/******************************************************************************/
/* viewer.js  -- The main moloch app
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
/*jshint
  node: true, plusplus: false, curly: true, eqeqeq: true, immed: true, latedef: true, newcap: true, nonew: true, undef: true, strict: true, trailing: true
*/
'use strict';

var MIN_DB_VERSION = 24;

//// Modules
//////////////////////////////////////////////////////////////////////////////////
try {
var Config         = require('./config.js'),
    express        = require('express'),
    stylus         = require('stylus'),
    util           = require('util'),
    fs             = require('fs-ext'),
    async          = require('async'),
    url            = require('url'),
    dns            = require('dns'),
    Pcap           = require('./pcap.js'),
    sprintf        = require('./public/sprintf.js'),
    Db             = require('./db.js'),
    os             = require('os'),
    zlib           = require('zlib'),
    molochparser   = require('./molochparser.js'),
    passport       = require('passport'),
    DigestStrategy = require('passport-http').DigestStrategy,
    HTTPParser     = process.binding('http_parser').HTTPParser,
    molochversion  = require('./version'),
    http           = require('http'),
    jade           = require('jade'),
    https          = require('https'),
    EventEmitter   = require('events').EventEmitter,
    KAA            = require('keep-alive-agent');
} catch (e) {
  console.log ("ERROR - Couldn't load some dependancies, maybe need to 'npm update' inside viewer directory", e);
  process.exit(1);
  throw new Error("Exiting");
}

try {
  var Png = require('png').Png;
} catch (e) {console.log("WARNING - No png support, maybe need to 'npm update'", e);}

if (typeof express !== "function") {
  console.log("ERROR - Need to run 'npm update' in viewer directory");
  process.exit(1);
  throw new Error("Exiting");
}
var app = express();

//////////////////////////////////////////////////////////////////////////////////
//// Config
//////////////////////////////////////////////////////////////////////////////////
var internals = {
  elasticBase: Config.get("elasticsearch", "http://localhost:9200").split(","),
  httpAgent:   new KAA({maxSockets: 40}),
  httpsAgent:  new KAA.Secure({maxSockets: 40}),
  previousNodeStats: [],
  caTrustCerts: {},
  cronRunning: false,
  rightClicks: {},
  pluginEmitter: new EventEmitter(),
  writers: {},

//http://garethrees.org/2007/11/14/pngcrush/
  emptyPNG: new Buffer("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==", 'base64'),
  PNG_LINE_WIDTH: 256,
};

if (internals.elasticBase[0].lastIndexOf('http', 0) !== 0) {
  internals.elasticBase[0] = "http://" + internals.elasticBase[0];
}

function userCleanup(suser) {
  suser.settings = suser.settings || {};
  if (suser.emailSearch === undefined) {suser.emailSearch = false;}
  if (suser.removeEnabled === undefined) {suser.removeEnabled = false;}
  if (Config.get("multiES", false)) {suser.createEnabled = false;}
}

passport.use(new DigestStrategy({qop: 'auth', realm: Config.get("httpRealm", "Moloch")},
  function(userid, done) {
    Db.getUserCache(userid, function(err, suser) {
      if (err && !suser) {return done(err);}
      if (!suser || !suser.found) {console.log("User", userid, "doesn't exist"); return done(null, false);}
      if (!suser._source.enabled) {console.log("User", userid, "not enabled"); return done("Not enabled");}

      userCleanup(suser._source);

      return done(null, suser._source, {ha1: Config.store2ha1(suser._source.passStore)});
    });
  },
  function (options, done) {
      //TODO:  Should check nonce here
      return done(null, true);
  }
));

app.configure(function() {
  app.enable("jsonp callback");
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.locals.molochversion =  molochversion.version;
  app.locals.isIndex = false;
  app.locals.basePath = Config.basePath();
  app.locals.elasticBase = internals.elasticBase[0];
  app.locals.allowUploads = Config.get("uploadCommand") !== undefined;
  app.locals.molochClusters = Config.configMap("moloch-clusters");

  app.use(express.favicon(__dirname + '/public/favicon.ico'));
  app.use(passport.initialize());
  app.use(function(req, res, next) {
    if (res.setTimeout) {
      res.setTimeout(10 * 60 * 1000); // Increase default from 2 min to 10 min
    }
    req.url = req.url.replace(Config.basePath(), "/");
    return next();
  });
  app.use(express.bodyParser({uploadDir: Config.get("pcapDir")}));

// send req to access log file or stdout
  var _stream = process.stdout;
  var _accesslogfile = Config.get("accessLogFile");
  if (_accesslogfile) {
    _stream = fs.createWriteStream(_accesslogfile, {flags: 'a'});
  }
  app.use(express.logger({ format: ':date :username \x1b[1m:method\x1b[0m \x1b[33m:url\x1b[0m :res[content-length] bytes :response-time ms', stream: _stream }));
  app.use(express.compress());
  app.use(express.methodOverride());
  app.use("/", express.static(__dirname + '/public', { maxAge: 600 * 1000}));
  if (Config.get("passwordSecret")) {
    app.locals.alwaysShowESStatus = false;
    app.use(function(req, res, next) {
      // 200 for NS
      if (req.url === "/_ns_/nstest.html") {
        return res.end();
      }

      // No auth for stats.json, dstats.json, esstats.json, eshealth.json
      if (req.url.match(/^\/([e]*[ds]*stats|eshealth).json/)) {
        return next();
      }

      // S2S Auth
      if (req.headers['x-moloch-auth']) {
        var obj = Config.auth2obj(req.headers['x-moloch-auth']);
        obj.path = obj.path.replace(Config.basePath(), "/");
        if (obj.path !== req.url) {
          console.log("ERROR - mismatch url", obj.path, req.url);
          return res.send("Unauthorized based on bad url, check logs on ", os.hostname());
        }
        if (Math.abs(Date.now() - obj.date) > 120000) { // Request has to be +- 2 minutes
          console.log("ERROR - Denying server to server based on timestamp, are clocks out of sync?", Date.now(), obj.date);
          return res.send("Unauthorized based on timestamp - check that all moloch viewer machines have accurate clocks");
        }

        if (req.url.match(/^\/receiveSession/)) {
          return next();
        }

        Db.getUserCache(obj.user, function(err, suser) {
          if (err) {return res.send("ERROR - user: " + obj.user + " err:" + err);}
          if (!suser || !suser.found) {return res.send(obj.user + " doesn't exist");}
          if (!suser._source.enabled) {return res.send(obj.user + " not enabled");}
          userCleanup(suser._source);
          req.user = suser._source;
          return next();
        });
        return;
      }

      // Header auth
      if (req.headers[Config.get("userNameHeader")] !== undefined) {
        var userName = req.headers[Config.get("userNameHeader")];
        Db.getUserCache(userName, function(err, suser) {
          if (err) {return res.send("ERROR - " +  err);}
          if (!suser || !suser.found) {return res.send(userName + " doesn't exist");}
          if (!suser._source.enabled) {return res.send(userName + " not enabled");}
          if (!suser._source.headerAuthEnabled) {return res.send(userName + " header auth not enabled");}

          userCleanup(suser._source);
          req.user = suser._source;
          return next();
        });
        return;
      }

      // Browser auth
      req.url = req.url.replace("/", Config.basePath());
      passport.authenticate('digest', {session: false})(req, res, function (err) {
        req.url = req.url.replace(Config.basePath(), "/");
        if (err) {
          res.send(JSON.stringify({success: false, text: err}));
          return;
        } else {
          return next();
        }
      });
    });
  } else {
    /* Shared password isn't set, who cares about auth */
    app.locals.alwaysShowESStatus = true;
    app.use(function(req, res, next) {
      req.user = {userId: "anonymous", enabled: true, createEnabled: Config.get("regressionTests", false), webEnabled: true, headerAuthEnabled: false, emailSearch: true, removeEnabled: true, settings: {}};
      next();
    });
  }

  app.use(function(req, res, next) {
    if (!req.user || !req.user.userId) {
      return next();
    }

    var mrc = {};
    for (var key in internals.rightClicks) {
      var rc = internals.rightClicks[key];
      if (!rc.users || rc.users[req.user.userId]) {
        mrc[key] = rc;
      }
    }
    app.locals.molochRightClick = mrc;
    next();
  });

  express.logger.token('username', function(req, res){ return req.user?req.user.userId:"-"; });
});

function loadFields() {
  Db.loadFields(function (data) {
    Config.loadFields(data);
    app.locals.fieldsMap = JSON.stringify(Config.getFieldsMap());
    app.locals.fieldsArr = Config.getFields().sort(function(a,b) {return (a.exp > b.exp?1:-1);});
  });
}

function loadPlugins() {
  var api = {
    registerWriter: function(str, info) {
      internals.writers[str] = info;
    },
    getDb: function() { return Db; },
    getPcap: function() { return Pcap; },
  };
  var plugins = Config.get("viewerPlugins", "").split(";");
  var dirs = Config.get("pluginsDir", "/data/moloch/plugins").split(";");
  plugins.forEach(function (plugin) {
    plugin = plugin.trim();
    if (plugin === "") {
      return;
    }
    var found = false;
    dirs.forEach(function (dir) {
      dir = dir.trim();
      if (found || dir === "") {
        return;
      }
      if (fs.existsSync(dir + "/" + plugin)) {
        found = true;
        var p = require(dir + "/" + plugin);
        p.init(Config, internals.pluginEmitter, api);
      }
    });
    if (!found) {
      console.log("WARNING - Couldn't find plugin", plugin, "in", dirs);
    }
  });
}

//////////////////////////////////////////////////////////////////////////////////
//// Utility
//////////////////////////////////////////////////////////////////////////////////
function isEmptyObject(object) { for(var i in object) { return false; } return true; }
function safeStr(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/\'/g, '&#39;').replace(/\//g, '&#47;');
}

function twoDigitString(value) {
  return (value < 10) ? ("0" + value) : value.toString();
}

var FMEnum = Object.freeze({other: 0, ip: 1, tags: 2, hh: 3});
function fmenum(field) {
  var fieldsMap = Config.getFieldsMap();
  if (field.match(/^(a1|a2|xff|dnsip|eip|socksip)$/) !== null ||
      fieldsMap[field] && fieldsMap[field].type === "ip") {
    return FMEnum.ip;
  } else if (field.match(/^(ta)$/) !== null) {
    return FMEnum.tags;
  } else if (field.match(/^(hh1|hh2)$/) !== null) {
    return FMEnum.hh;
  }
  return FMEnum.other;
}

function errorString(err, result) {
  var str;
  if (err && typeof err === "string") {
    str = err;
  } else if (err && typeof err.message === "string") {
    str = err.message;
  } else if (result && result.error) {
    str = result.error;
  } else {
    str = "Unknown issue, check logs";
    console.log(err, result);
  }

  if (str.match("IndexMissingException")) {
    return "Moloch's Elasticsearch database has no matching session indices for timeframe selected";
  } else {
    return "Elasticsearch error: " + str;
  }
}

// http://stackoverflow.com/a/10934946
function dot2value(obj, str) {
      return str.split(".").reduce(function(o, x) { return o[x]; }, obj);
}

function createSessionDetail() {
  var found = {};
  var dirs;

  dirs = Config.get("pluginsDir", "/data/moloch/plugins");
  if (dirs) {
    dirs.split(';').forEach(function(dir) {
      try {
        var files = fs.readdirSync(dir);
        files.forEach(function(file) {
          if (file.match(/\.detail\.jade$/i) && !found["plugin-" + file]) {
            found[file] = "  include " + dir + "/" + file + "\n";
          }
        });
      } catch (e) {}
    });
  }

  dirs = Config.get("parsersDir", "/data/moloch/parsers");
  if (dirs) {
    dirs.split(';').forEach(function(dir) {
      try {
        var files = fs.readdirSync(dir);
        files.forEach(function(file) {
          if (file.match(/\.detail\.jade$/i) && !found["parser-" + file]) {
            found[file] = "  include " + dir + "/" + file + "\n";
          }
        });
      } catch (e) {}
    });
  }

  var makers = internals.pluginEmitter.listeners("makeSessionDetail");
  async.each(makers, function(cb, nextCb) {
    cb(function (err, items) {
      for (var k in items) {
        found[k] = items[k].replace(/^/mg, "  ") + "\n";
      }
      return nextCb();
    });
  }, function () {
    internals.sessionDetail =    "include views/mixins\n" +
                                 "div.sessionDetail(sessionid='#{session.id}')\n" +
                                 "  include views/sessionDetail-standard\n";
    Object.keys(found).sort().forEach(function(k) {
      internals.sessionDetail += found[k];
    });
    internals.sessionDetail +=   "  include views/sessionDetail-body\n";
    internals.sessionDetail +=   "include views/sessionDetail-footer\n";
  });
}

function createRightClicks() {

  var mrc = Config.configMap("right-click");
  for (var key in mrc) {
    if (mrc[key].fields) {
      mrc[key].fields = mrc[key].fields.split(",");
    }
    if (mrc[key].users) {
      var users = {};
      mrc[key].users.split(",").forEach(function(item) {
        users[item] = 1;
      });
      mrc[key].users = users;
    }
  }
  var makers = internals.pluginEmitter.listeners("makeRightClick");
  async.each(makers, function(cb, nextCb) {
    cb(function (err, items) {
      for (var k in items) {
        mrc[k] = items[k];
        if (mrc[k].fields && !Array.isArray(mrc[k].fields)) {
          mrc[k].fields = mrc[k].fields.split(",");
        }
      }
      return nextCb();
    });
  }, function () {
    internals.rightClicks = mrc;
  });
}

//https://coderwall.com/p/pq0usg/javascript-string-split-that-ll-return-the-remainder
function splitRemain(str, separator, limit) {
    str = str.split(separator);
    if(str.length <= limit) {return str;}

    var ret = str.splice(0, limit);
    ret.push(str.join(separator));

    return ret;
}

//////////////////////////////////////////////////////////////////////////////////
//// Requests
//////////////////////////////////////////////////////////////////////////////////

function addAuth(info, user, node, secret) {
    if (!info.headers) {
        info.headers = {};
    }
    info.headers['x-moloch-auth'] = Config.obj2auth({date: Date.now(),
                                                     user: user.userId,
                                                     node: node,
                                                     path: info.path
                                                    }, secret);
}

function addCaTrust(info, node) {
  if (!Config.isHTTPS(node)) {
    return;
  }

  if ((internals.caTrustCerts[node] !== undefined) && (internals.caTrustCerts[node].length > 0)) {
    info.ca = internals.caTrustCerts[node];
    info.agent.options.ca = internals.caTrustCerts[node];
    return;
  }

  var caTrustFile = Config.getFull(node, "caTrustFile");

  if (caTrustFile && caTrustFile.length > 0) {
    var caTrustFileLines = fs.readFileSync(caTrustFile, 'utf8');
    caTrustFileLines = caTrustFileLines.split("\n");

    var foundCert = [],
        line;

    internals.caTrustCerts[node] = [];

    for (var i = 0, ilen = caTrustFileLines.length; i < ilen; i++) {
      line = caTrustFileLines[i];
      if (line.length === 0) {
        continue;
      }
      foundCert.push(line);
      if (line.match(/-END CERTIFICATE-/)) {
        internals.caTrustCerts[node].push(foundCert.join("\n"));
        foundCert = [];
      }
    }

    if (internals.caTrustCerts[node].length > 0) {
      info.ca = internals.caTrustCerts[node];
      info.agent.options.ca = internals.caTrustCerts[node];
      return;
    }
  }
}

function noCache(req, res, ct) {
  res.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');
  if (ct) {
    res.setHeader("Content-Type", ct);
  }
}

function getViewUrl(node, cb) {
  if (Array.isArray(node)) {
    node = node[0];
  }

  var url = Config.getFull(node, "viewUrl");
  if (url) {
    cb(null, url, url.slice(0, 5) === "https"?https:http);
    return;
  }

  Db.molochNodeStatsCache(node, function(err, stat) {
    if (err) {
      return cb(err);
    }

    if (Config.isHTTPS(node)) {
      cb(null, "https://" + stat.hostname + ":" + Config.getFull(node, "viewPort", "8005"), https);
    } else {
      cb(null, "http://" + stat.hostname + ":" + Config.getFull(node, "viewPort", "8005"), http);
    }
  });
}

function proxyRequest (req, res, errCb) {
  noCache(req, res);

  getViewUrl(req.params.nodeName, function(err, viewUrl, client) {
    if (err) {
      if (errCb) {
        return errCb(err);
      }
      console.log("ERROR - ", err);
      res.send("Can't find view url for '" + req.params.nodeName + "' check viewer logs on " + os.hostname());
    }
    var info = url.parse(viewUrl);
    info.path = req.url;
    info.agent = (client === http?internals.httpAgent:internals.httpsAgent);
    info.rejectUnauthorized = true;
    addAuth(info, req.user, req.params.nodeName);
    addCaTrust(info, req.params.nodeName);

    var preq = client.request(info, function(pres) {
      if (pres.headers['content-type']) {
        res.setHeader('content-type', pres.headers['content-type']);
      }
      pres.on('data', function (chunk) {
        res.write(chunk);
      });
      pres.on('end', function () {
        res.end();
      });
    });

    preq.on('error', function (e) {
      if (errCb) {
        return errCb(e);
      }
      console.log("ERROR - Couldn't proxy request=", info, "\nerror=", e);
      res.send("Error talking to node '" + req.params.nodeName + "' using host '" + info.host + "' check viewer logs on " + os.hostname());
    });
    preq.end();
  });
}

function isLocalView (node, yesCb, noCb) {
  var pcapWriteMethod = Config.getFull(node, "pcapWriteMethod");
  var writer = internals.writers[pcapWriteMethod];
  if (writer && writer.localNode === false) {
    return yesCb();
  }
  return Db.isLocalView(node, yesCb, noCb);
}

//////////////////////////////////////////////////////////////////////////////////
//// Middleware
//////////////////////////////////////////////////////////////////////////////////
function checkProxyRequest(req, res, next) {
  isLocalView(req.params.nodeName, function () {
    return next();
  },
  function () {
    return proxyRequest(req, res);
  });
}

function checkToken(req, res, next) {
  if (!req.body.token) {
    return res.send(JSON.stringify({success: false, text: "Missing token"}));
  }

  req.token = Config.auth2obj(req.body.token);
  var diff = Math.abs(Date.now() - req.token.date);
  if (diff > 2400000 || req.token.pid !== process.pid || req.token.userId !== req.user.userId) {
    console.trace("bad token", req.token);
    return res.send(JSON.stringify({success: false, text: "Timeout - Please try reloading page and repeating the action"}));
  }

  // Shorter token timeout if editing someone elses info
  if (req.token.suserId && req.token.userId !== req.user.userId && diff > 600000) {
    console.trace("admin bad token", req.token);
    return res.send(JSON.stringify({success: false, text: "Admin Timeout - Please try reloading page and repeating the action"}));
  }

  return next();
}

function checkWebEnabled(req, res, next) {
  if (!req.user.webEnabled) {
    return res.send("Moloch Permision Denied");
  }

  return next();
}
//////////////////////////////////////////////////////////////////////////////////
//// Pages
//////////////////////////////////////////////////////////////////////////////////
function makeTitle(req, page) {
  var title = Config.get("titleTemplate", "_cluster_ - _page_ _-view_ _-expression_");
  title = title.replace(/_cluster_/g, internals.clusterName)
               .replace(/_page_/g, page)
               .replace(/_userId_/g, req.user?req.user.userId:"-")
               .replace(/_userName_/g, req.user?req.user.userName:"-")
               ;
  return title;
}

app.get("/", checkWebEnabled, function(req, res) {
  res.render('index', {
    user: req.user,
    title: makeTitle(req, 'Sessions'),
    titleLink: 'sessionsLink',
    isIndex: true
  });
});

app.get("/spiview", checkWebEnabled, function(req, res) {
  res.render('spiview', {
    user: req.user,
    title: makeTitle(req, 'SPI View'),
    titleLink: 'spiLink',
    isIndex: true,
    reqFields: Config.headers("headers-http-request"),
    resFields: Config.headers("headers-http-response"),
    emailFields: Config.headers("headers-email"),
    categories: Config.getCategories(),
    token: Config.obj2auth({date: Date.now(), pid: process.pid, userId: req.user.userId, suserId: req.user.userId})
  });
});

app.get("/spigraph", checkWebEnabled, function(req, res) {
  res.render('spigraph', {
    user: req.user,
    title: makeTitle(req, 'SPI Graph'),
    titleLink: 'spigraphLink',
    isIndex: true
  });
});

app.get("/connections", checkWebEnabled, function(req, res) {
  res.render('connections', {
    user: req.user,
    title: makeTitle(req, 'Connections'),
    titleLink: 'connectionsLink',
    isIndex: true
  });
});

app.get("/upload", checkWebEnabled, function(req, res) {
  res.render('upload', {
    user: req.user,
    title: makeTitle(req, 'Upload'),
    titleLink: 'uploadLink',
    isIndex: false
  });
});

app.get('/about', checkWebEnabled, function(req, res) {
  res.render('about', {
    user: req.user,
    title: makeTitle(req, 'About'),
    titleLink: 'aboutLink'
  });
});

app.get('/files', checkWebEnabled, function(req, res) {
  res.render('files', {
    user: req.user,
    title: makeTitle(req, 'Files'),
    titleLink: 'filesLink'
  });
});

app.get('/users', checkWebEnabled, function(req, res) {
  res.render('users', {
    user: req.user,
    title: makeTitle(req, 'Users'),
    titleLink: 'usersLink',
    token: Config.obj2auth({date: Date.now(), pid: process.pid, userId: req.user.userId})
  });
});

app.get('/settings', checkWebEnabled, function(req, res) {
  var actions = [{name: "Tag", value: "tag"}];

  var molochClusters = Config.configMap("moloch-clusters");
  if (molochClusters) {
    Object.keys(molochClusters).forEach( function (cluster) {
      actions.push({name: "Tag & Export to " + molochClusters[cluster].name, value: "forward:" + cluster});
    });
  }

  function render(user, cp) {
    if (user.settings === undefined) {user.settings = {};}
    Db.search("queries", "query", {size:1000, query: {term: {creator: user.userId}}}, function (err, data) {
      if (data && data.hits && data.hits.hits) {
        user.queries = {};
        data.hits.hits.forEach(function(item) {
          user.queries[item._id] = item._source;
        });
      }
      actions = actions.sort();

      res.render('settings', {
        user: req.user,
        suser: user,
        currentPassword: cp,
        token: Config.obj2auth({date: Date.now(), pid: process.pid, userId: req.user.userId, suserId: user.userId, cp:cp}),
        title: makeTitle(req, 'Settings'),
        titleLink: 'settingsLink',
        actions: actions
      });
    });
  }

  if (Config.get("disableChangePassword", false)) {
    return res.send("Disabled");
  }

  if (req.query.userId) {
    if (!req.user.createEnabled && req.query.userId !== req.user.userId) {
      return res.send("Moloch Permision Denied");
    }
    Db.getUser(req.query.userId, function(err, user) {
      if (err || !user.found) {
        console.log("ERROR - /password error", err, user);
        return res.send("Unknown user");
      }
      render(user._source, 0);
    });
  } else {
    render(req.user, 1);
  }
});

app.get('/stats', checkWebEnabled, function(req, res) {
  var query = {size: 100};

  Db.search('stats', 'stat', query, function(err, data) {
    var hits = data.hits.hits;
    var nodes = [];
    hits.forEach(function(hit) {
      nodes.push(hit._id);
    });
    nodes.sort();
    res.render('stats', {
      user: req.user,
      title: makeTitle(req, 'Stats'),
      titleLink: 'statsLink',
      nodes: nodes
    });
  });
});

app.get('/:nodeName/statsDetail', checkWebEnabled, function(req, res) {
  res.render('statsDetail', {
    user: req.user,
    nodeName: req.params.nodeName
  });
});

fs.unlink("./public/style.css", function () {}); // Remove old style.css file
app.get('/style.css', function(req, res) {
  fs.readFile("./views/style.styl", 'utf8', function(err, str) {
    if (err) {return console.log("ERROR - ", err);}
    var style = stylus(str);
    style.render(function(err, css){
      if (err) {return console.log("ERROR - ", err);}
      var date = new Date().toUTCString();
      res.setHeader('Content-Type', 'text/css');
      res.setHeader('Date', date);
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('Last-Modified', date);
      res.send(css);
    });
  });
});

//////////////////////////////////////////////////////////////////////////////////
//// EXPIRING
//////////////////////////////////////////////////////////////////////////////////
// Search for all files on a set of nodes in a set of directories.
// If less then size items are returned we don't delete anything.
// Doesn't support mounting sub directories in main directory, don't do it.
function expireDevice (nodes, dirs, minFreeSpaceG, nextCb) {
  var query = { _source: [ 'num', 'name', 'first', 'size', 'node' ],
                  from: '0',
                  size: 100,
                 query: { bool: {
                    must: [
                          {terms: {node: nodes}},
                          { bool: {should: []}}
                        ],
                    must_not: { term: {locked: 1}}
                }},
                sort: { first: { order: 'asc' } } };

  Object.keys(dirs).forEach( function (pcapDir) {
    var obj = {wildcard: {}};
    if (pcapDir[pcapDir.length - 1] === "/") {
      obj.wildcard.name = pcapDir + "*";
    } else {
      obj.wildcard.name = pcapDir + "/*";
    }
    query.query.bool.must[1].bool.should.push(obj);
  });

  Db.search('files', 'file', query, function(err, data) {
      if (err || data.error || !data.hits || data.hits.total <= query.size) {
        return nextCb();
      }
      async.forEachSeries(data.hits.hits, function(item, forNextCb) {
        if (data.hits.total <= 10) {
          return forNextCb("DONE");
        }

        var fields = item._source || item.fields;

        var freeG;
        try {
          var stat = fs.statVFS(fields.name);
          freeG = stat.f_frsize/1024.0*stat.f_bavail/(1024.0*1024.0);
        } catch (e) {
          console.log("ERROR", e);
          // File doesn't exist, delete it
          freeG = minFreeSpaceG - 1;
        }
        if (freeG < minFreeSpaceG) {
          data.hits.total--;
          console.log("Deleting", item);
          return Db.deleteFile(fields.node, item._id, fields.name, forNextCb);
        } else {
          return forNextCb("DONE");
        }
      }, function () {
        return nextCb();
      });
  });
}

function expireCheckDevice (nodes, stat, nextCb) {
  var doit = false;
  var minFreeSpaceG = 0;
  async.forEach(nodes, function(node, cb) {
    var freeSpaceG = Config.getFull(node, "freeSpaceG", 301);
    if (freeSpaceG[freeSpaceG.length-1] === "%") {
      freeSpaceG = (+freeSpaceG.substr(0,freeSpaceG.length-1)) * 0.01 * stat.f_frsize/1024.0*stat.f_blocks/(1024.0*1024.0);
    }
    var freeG = stat.f_frsize/1024.0*stat.f_bavail/(1024.0*1024.0);
    if (freeG < freeSpaceG) {
      doit = true;
    }

    if (freeSpaceG > minFreeSpaceG) {
      minFreeSpaceG = freeSpaceG;
    }

    cb();
  }, function () {
    if (doit) {
      expireDevice(nodes, stat.dirs, minFreeSpaceG, nextCb);
    } else {
      return nextCb();
    }
  });
}

function expireCheckAll () {
  var devToStat = {};
  // Find all the nodes running on this host
  Db.hostnameToNodeids(os.hostname(), function(nodes) {
    // Find all the pcap dirs for local nodes
    async.map(nodes, function (node, cb) {
      var pcapDirs = Config.getFull(node, "pcapDir");
      if (typeof pcapDirs !== "string") {
        return cb("ERROR - couldn't find pcapDir setting for node: " + node + "\nIf you have it set try running:\nnpm remove iniparser; npm cache clean; npm update iniparser");
      }
      // Create a mapping from device id to stat information and all directories on that device
      pcapDirs.split(";").forEach(function (pcapDir) {
        pcapDir = pcapDir.trim();
        var fileStat = fs.statSync(pcapDir);
        var vfsStat = fs.statVFS(pcapDir);
        if (!devToStat[fileStat.dev]) {
          vfsStat.dirs = {};
          vfsStat.dirs[pcapDir] = {};
          devToStat[fileStat.dev] = vfsStat;
        } else {
          devToStat[fileStat.dev].dirs[pcapDir] = {};
        }
      });
      cb(null);
    },
    function (err) {
      // Now gow through all the local devices and check them
      var keys = Object.keys(devToStat);
      async.forEachSeries(keys, function (key, cb) {
        expireCheckDevice(nodes, devToStat[key], cb);
      }, function (err) {
      });
    });
  });
}
//////////////////////////////////////////////////////////////////////////////////
//// Sessions Query
//////////////////////////////////////////////////////////////////////////////////
function addSortToQuery(query, info, d, missing) {
  if (!info || !info.iSortingCols || parseInt(info.iSortingCols, 10) === 0) {
    if (d) {
      if (!query.sort) {
        query.sort = [];
      }
      query.sort.push({});
      query.sort[query.sort.length-1][d] = {order: "asc"};
      if (missing && missing[d] !== undefined) {
        query.sort[query.sort.length-1][d].missing = missing[d];
      }
    }
    return;
  }

  if (!query.sort) {
    query.sort = [];
  }

  for (var i = 0, ilen = parseInt(info.iSortingCols, 10); i < ilen; i++) {
    if (!info["iSortCol_" + i] || !info["sSortDir_" + i] || !info["mDataProp_" + info["iSortCol_" + i]]) {
      continue;
    }

    var obj = {};
    var field = info["mDataProp_" + info["iSortCol_" + i]];
    obj[field] = {order: info["sSortDir_" + i]};
    if (missing && missing[field] !== undefined) {
      obj[field].missing = missing[field];
    }
    query.sort.push(obj);

    if (field === "fp") {
      query.sort.push({fpd: {order: info["sSortDir_" + i]}});
    } else if (field === "lp") {
      query.sort.push({lpd: {order: info["sSortDir_" + i]}});
    }
  }
}

/* This method fixes up parts of the query that jison builds to what ES actually
 * understands.  This includes mapping all the tag fields from strings to numbers
 * and any of the filename stuff
 */
function lookupQueryItems(query, doneCb) {
  if (Config.get("multiES", false)) {
    return doneCb(null);
  }

  var outstanding = 0;
  var finished = 0;
  var err = null;

  function process(parent, obj, item) {
    //console.log("\nprocess:\n", item, obj, typeof obj[item], "\n");
    if ((item === "ta" || item === "hh" || item === "hh1" || item === "hh2") && (typeof obj[item] === "string" || Array.isArray(obj[item]))) {
      if (obj[item].indexOf("*") !== -1) {
        delete parent.wildcard;
        outstanding++;
        var query;
        if (item === "ta") {
          query = {bool: {must: {wildcard: {_id: obj[item]}},
                          must_not: {wildcard: {_id: "http:header:*"}}
                         }
                  };
        } else {
          query = {wildcard: {_id: "http:header:" + obj[item].toLowerCase()}};
        }
        Db.search('tags', 'tag', {size:500, _source:["id", "n"], query: query}, function(err, result) {
          var terms = [];
          result.hits.hits.forEach(function (hit) {
            var fields = hit._source || hit.fields;
            terms.push(fields.n);
          });
          parent.terms = {};
          parent.terms[item] = terms;
          outstanding--;
          if (finished && outstanding === 0) {
            doneCb(err);
          }
        });
      } else if (Array.isArray(obj[item])) {
        outstanding++;

        async.map(obj[item], function(str, cb) {
          var tag = (item !== "ta"?"http:header:" + str.toLowerCase():str);
          Db.tagNameToId(tag, function (id) {
            if (id === null) {
              console.log("Tag '" + tag + "' not found");
              cb(null, -1);
            } else {
              cb(null, id);
            }
          });
        },
        function (err, results) {
          outstanding--;
          obj[item] = results;
          if (finished && outstanding === 0) {
            doneCb(err);
          }
        });
      } else {
        outstanding++;
        var tag = (item !== "ta"?"http:header:" + obj[item].toLowerCase():obj[item]);

        Db.tagNameToId(tag, function (id) {
          outstanding--;
          if (id === null) {
            err = "Tag '" + tag + "' not found";
          } else {
            obj[item] = id;
          }
          if (finished && outstanding === 0) {
            doneCb(err);
          }
        });
      }
    } else if (item === "fileand" && typeof obj[item] === "string") {
      var name = obj.fileand;
      delete obj.fileand;
      outstanding++;
      Db.fileNameToFiles(name, function (files) {
        outstanding--;
        if (files === null || files.length === 0) {
          err = "File '" + name + "' not found";
        } else if (files.length > 1) {
          obj.bool = {should: []};
          files.forEach(function(file) {
            obj.bool.should.push({bool: {must: [{term: {no: file.node}}, {term: {fs: file.num}}]}});
          });
        } else {
          obj.bool = {must: [{term: {no: files[0].node}}, {term: {fs: files[0].num}}]};
        }
        if (finished && outstanding === 0) {
          doneCb(err);
        }
      });
    } else if (typeof obj[item] === "object") {
      convert(obj, obj[item]);
    }
  }

  function convert(parent, obj) {
    for (var item in obj) {
      process(parent, obj, item);
    }
  }

  convert(null, query);
  if (outstanding === 0) {
    return doneCb(err);
  }

  finished = 1;
}

function buildSessionQuery(req, buildCb) {
  var limit = (req.query.iDisplayLength?Math.min(parseInt(req.query.iDisplayLength, 10),2000000):100);
  var i;


  var query = {from: req.query.iDisplayStart || 0,
               size: limit,
               query: {filtered: {query: {}}}
              };

  var interval;
  if (req.query.date && req.query.date === '-1') {
    interval = 60*60; // Hour to be safe
    query.query.filtered.query.match_all = {};
  } else if (req.query.startTime && req.query.stopTime) {
    if (! /^[0-9]+$/.test(req.query.startTime)) {
      req.query.startTime = Date.parse(req.query.startTime.replace("+", " "))/1000;
    } else {
      req.query.startTime = parseInt(req.query.startTime, 10);
    }

    if (! /^[0-9]+$/.test(req.query.stopTime)) {
      req.query.stopTime = Date.parse(req.query.stopTime.replace("+", " "))/1000;
    } else {
      req.query.stopTime = parseInt(req.query.stopTime, 10);
    }
    if (req.query.strictly === "true") {
      query.query.filtered.query.bool = {must: [{range: {fp: {gte: req.query.startTime}}}, {range: {lp: {lte: req.query.stopTime}}}]};
    } else {
      query.query.filtered.query.range = {lp: {gte: req.query.startTime, lte: req.query.stopTime}};
    }

    var diff = req.query.stopTime - req.query.startTime;
    if (diff < 30*60) {
      interval = 1; // second
    } else if (diff <= 5*24*60*60) {
      interval = 60; // minute
    } else {
      interval = 60*60; // hour
    }
  } else {
    if (!req.query.date) {
      req.query.date = 1;
    }
    req.query.startTime = (Math.floor(Date.now() / 1000) - 60*60*parseInt(req.query.date, 10));
    req.query.stopTime = Date.now()/1000;
    query.query.filtered.query.range = {lp: {from: req.query.startTime}};
    if (req.query.date <= 5*24) {
      interval = 60; // minute
    } else {
      interval = 60*60; // hour
    }
  }

  if (req.query.facets) {
    query.aggregations = {g1: {terms: {field: "g1", size:1000}}, 
                          g2: {terms: {field: "g2", size:1000}},
                     dbHisto: {histogram : {field: "lp", interval: interval}, aggregations: {db : {sum: {field:"db"}}, pa: {sum: {field:"pa"}}}}
                 };
  }

  addSortToQuery(query, req.query, "fp");

  var err = null;
  molochparser.parser.yy = {emailSearch: req.user.emailSearch === true,
                                  views: req.user.views,
                              fieldsMap: Config.getFieldsMap()};
  if (req.query.expression) {
    //req.query.expression = req.query.expression.replace(/\\/g, "\\\\");
    try {
      query.query.filtered.filter = molochparser.parse(req.query.expression);
    } catch (e) {
      err = e;
    }
  }

  if (!err && req.query.view && req.user.views && req.user.views[req.query.view]) {
    try {
      var viewExpression = molochparser.parse(req.user.views[req.query.view].expression);
      if (query.query.filtered.filter === undefined) {
        query.query.filtered.filter = viewExpression;
      } else {
        query.query.filtered.filter = {bool: {must: [viewExpression, query.query.filtered.filter]}};
      }
    } catch (e) {
      console.log("ERR - User expression doesn't compile", req.user.views[req.query.view], e);
      err = e;
    }
  }

  if (!err && req.user.expression && req.user.expression.length > 0) {
    try {
      // Expression was set by admin, so assume email search ok
      molochparser.parser.yy.emailSearch = true;
      var userExpression = molochparser.parse(req.user.expression);
      if (query.query.filtered.filter === undefined) {
        query.query.filtered.filter = userExpression;
      } else {
        query.query.filtered.filter = {bool: {must: [userExpression, query.query.filtered.filter]}};
      }
    } catch (e) {
      console.log("ERR - Forced expression doesn't compile", req.user.expression, e);
      err = e;
    }
  }

  lookupQueryItems(query.query.filtered, function (lerr) {
    if (req.query.date && req.query.date === '-1') {
      return buildCb(err || lerr, query, "sessions-*");
    }

    Db.getIndices(req.query.startTime, req.query.stopTime, Config.get("rotateIndex", "daily"), function(indices) {
      return buildCb(err || lerr, query, indices);
    });
  });
}
//////////////////////////////////////////////////////////////////////////////////
//// Sessions List
//////////////////////////////////////////////////////////////////////////////////
function sessionsListAddSegments(req, indices, query, list, cb) {
  var processedRo = {};

  // Index all the ids we have, so we don't include them again
  var haveIds = {};
  list.forEach(function(item) {
    haveIds[item._id] = true;
  });

  delete query.aggregations;
  if (req.query.segments === "all") {
    indices = "sessions-*";
    query.query.filtered.query = {match_all: {}};
  }

  // Do a ro search on each item
  var writes = 0;
  async.eachLimit(list, 10, function(item, nextCb) {
    var fields = item._source || item.fields;
    if (!fields.ro || processedRo[fields.ro]) {
      if (writes++ > 100) {
        writes = 0;
        setImmediate(nextCb);
      } else {
        nextCb();
      }
      return;
    }
    processedRo[fields.ro] = true;

    query.query.filtered.filter = {term: {ro: fields.ro}};

    Db.searchPrimary(indices, 'session', query, function(err, result) {
      if (err || result === undefined || result.hits === undefined || result.hits.hits === undefined) {
        console.log("ERROR fetching matching sessions", err, result);
        return nextCb(null);
      }
      result.hits.hits.forEach(function(item) {
        if (!haveIds[item._id]) {
          haveIds[item._id] = true;
          list.push(item);
        }
      });
      return nextCb(null);
    });
  }, function (err) {
    cb(err, list);
  });
}

function sessionsListFromQuery(req, res, fields, cb) {
  if (req.query.segments && fields.indexOf("ro") === -1) {
    fields.push("ro");
  }

  buildSessionQuery(req, function(err, query, indices) {
    query._source = fields;
    Db.searchPrimary(indices, 'session', query, function(err, result) {
      if (err || result.error) {
          console.log("ERROR - Could not fetch list of sessions.  Err: ", err,  " Result: ", result, "query:", query);
          return res.send("Could not fetch list of sessions.  Err: " + err + " Result: " + result);
      }
      var list = result.hits.hits;
      if (req.query.segments) {
        sessionsListAddSegments(req, indices, query, list, function(err, list) {
          cb(err, list);
        });
      } else {
        cb(err, list);
      }
    });
  });
}

function sessionsListFromIds(req, ids, fields, cb) {
  var list = [];
  var nonArrayFields = ["pr", "fp", "lp", "a1", "p1", "g1", "a2", "p2", "g2", "by", "db", "pa", "no", "ro"];
  var fixFields = nonArrayFields.filter(function(x) {return fields.indexOf(x) !== -1;});

  async.eachLimit(ids, 10, function(id, nextCb) {
    Db.getWithOptions(Db.id2Index(id), 'session', id, {fields: fields.join(",")}, function(err, session) {
      if (err) {
        return nextCb(null);
      }

      for (var i = 0; i < fixFields.length; i++) {
        var field = fixFields[i];
        if (session.fields[field] && Array.isArray(session.fields[field])) {
          session.fields[field] = session.fields[field][0];
        }
      }

      list.push(session);
      nextCb(null);
    });
  }, function(err) {
    if (req && req.query.segments) {
      buildSessionQuery(req, function(err, query, indices) {
        query._source = fields;
        sessionsListAddSegments(req, indices, query, list, function(err, list) {
          cb(err, list);
        });
      });
    } else {
      cb(err, list);
    }
  });
}

//////////////////////////////////////////////////////////////////////////////////
//// APIs
//////////////////////////////////////////////////////////////////////////////////
app.get('/eshealth.json', function(req, res) {
  Db.healthCache(function(err, health) {
    res.send(health);
  });
});

app.get('/esstats.json', function(req, res) {
  var stats = [];
  var r;

  async.parallel({
    nodes: function(nodesCb) {
      Db.nodesStats({jvm: 1, process: 1, fs: 1, search: 1, os: 1}, nodesCb);
    },
    health: Db.healthCache
  },
  function(err, results) {
    if (err || !results.nodes) {
      console.log ("ERROR", err);
      r = {sEcho: req.query.sEcho,
           health: results.health,
           iTotalRecords: 0,
           iTotalDisplayRecords: 0,
           aaData: []};
      return res.send(r);
    }

    var now = new Date().getTime();
    while (internals.previousNodeStats.length > 1 && internals.previousNodeStats[1].timestamp + 10000 < now) {
      internals.previousNodeStats.shift();
    }

    var nodes = Object.keys(results.nodes.nodes);
    for (var n = 0, nlen = nodes.length; n < nlen; n++) {
      var node = results.nodes.nodes[nodes[n]];
      stats.push({
        name: node.name,
        storeSize: node.indices.store.size_in_bytes,
        docs: node.indices.docs.count,
        searches: node.indices.search.query_current,
        searchesTime: node.indices.search.query_time_in_millis,
        heapSize: node.jvm.mem.heap_used_in_bytes,
        nonHeapSize: node.jvm.mem.non_heap_used_in_bytes,
        cpu: node.process.cpu.percent,
        read: 0,
        write: 0,
        load: node.os.load_average
      });

      var oldnode = internals.previousNodeStats[0][nodes[n]];
      if (oldnode) {
        var olddisk = [0, 0], newdisk = [0, 0];
        for (var i = 0, ilen = oldnode.fs.data.length; i < ilen; i++) {
          olddisk[0] += oldnode.fs.data[i].disk_read_size_in_bytes;
          olddisk[1] += oldnode.fs.data[i].disk_write_size_in_bytes;
          newdisk[0] += node.fs.data[i].disk_read_size_in_bytes;
          newdisk[1] += node.fs.data[i].disk_write_size_in_bytes;
        }

        stats[stats.length-1].read  = Math.ceil((newdisk[0] - olddisk[0])/(node.timestamp - oldnode.timestamp));
        stats[stats.length-1].write = Math.ceil((newdisk[1] - olddisk[1])/(node.timestamp - oldnode.timestamp));
      }
    }

    results.nodes.nodes.timestamp = new Date().getTime();
    internals.previousNodeStats.push(results.nodes.nodes);

    r = {sEcho: req.query.sEcho,
         health: results.health,
         iTotalRecords: stats.length,
         iTotalDisplayRecords: stats.length,
         aaData: stats};
    res.send(r);
  });
});

function mergeUnarray(to, from) {
  for (var key in from) {
    if (Array.isArray(from[key])) {
      to[key] = from[key][0];
    } else {
      to[key] = from[key];
    }
  }
}
app.get('/stats.json', function(req, res) {
  noCache(req, res);

  var columns = ["_id", "currentTime", "totalPackets", "totalK", "totalSessions", "monitoring", "memory", "cpu", "diskQueue", "freeSpaceM", "deltaPackets", "deltaBytes", "deltaSessions", "deltaDropped", "deltaMS"];
  var limit = (req.query.iDisplayLength?Math.min(parseInt(req.query.iDisplayLength, 10),1000000):500);

  var query = {_source: columns,
               from: req.query.iDisplayStart || 0,
               size: limit
              };
  addSortToQuery(query, req.query, "_uid");

  async.parallel({
    stats: function (cb) {
      Db.search('stats', 'stat', query, function(err, result) {
        if (err || result.error) {
          res.send({total: 0, results: []});
        } else {
          var results = {total: result.hits.total, results: []};
          for (var i = 0, ilen = result.hits.hits.length; i < ilen; i++) {
            var fields = result.hits.hits[i]._source || result.hits.hits[i].fields;
            if (result.hits.hits[i]._source) {
              mergeUnarray(fields, result.hits.hits[i].fields);
            }
            fields.id        = result.hits.hits[i]._id;
            fields.memory    = fields.memory || 0;
            fields.cpu       = fields.cpu || 0;
            fields.diskQueue = fields.diskQueue || 0;
            fields.deltaBytesPerSec = Math.floor(fields.deltaBytes * 1000.0/fields.deltaMS);
            fields.deltaPacketsPerSec = Math.floor(fields.deltaPackets * 1000.0/fields.deltaMS);
            fields.deltaSessionsPerSec = Math.floor(fields.deltaSessions * 1000.0/fields.deltaMS);
            fields.deltaDroppedPerSec = Math.floor(fields.deltaDropped * 1000.0/fields.deltaMS);
            results.results.push(fields);
          }
          cb(null, results);
        }
      });
    },
    total: function (cb) {
      Db.numberOfDocuments('stats', cb);
    }
  },
  function(err, results) {
    var r = {sEcho: req.query.sEcho,
             iTotalRecords: results.total,
             iTotalDisplayRecords: results.stats.total,
             aaData: results.stats.results};
    res.send(r);
  });
});

app.get('/dstats.json', function(req, res) {
  noCache(req, res);

  var query = {size: req.query.size || 1440,
               sort: { currentTime: { order: 'desc' } },
               query: {
                 filtered: {
                   query: {
                     match_all: {}
                   },
                   filter: {
                     and: [
                       {
                         term: { nodeName: req.query.nodeName}
                       },
                       {
                         numeric_range: { currentTime: { from: req.query.start, to: req.query.stop } }
                       },
                       {
                         term: { interval: req.query.interval || 60}
                       }
                     ]
                   }
                 }
               }
              };

  Db.search('dstats', 'dstat', query, function(err, result) {
    var i, ilen;
    var data = [];
    var num = (req.query.stop - req.query.start)/req.query.step;

    for (i = 0; i < num; i++) {
      data[i] = 0;
    }

    var mult = 1;
    if (req.query.name === "freeSpaceM") {
      mult = 1000000;
    }

    if (result && result.hits) {
      for (i = 0, ilen = result.hits.hits.length; i < ilen; i++) {
        var fields = result.hits.hits[i]._source || result.hits.hits[i].fields;
        if (result.hits.hits[i]._source) {
          mergeUnarray(fields, result.hits.hits[i].fields);
        }
        var pos = Math.floor((fields.currentTime - req.query.start)/req.query.step);
        fields.deltaBits           = Math.floor(fields.deltaBytes * 8.0);
        fields.deltaBytesPerSec    = Math.floor(fields.deltaBytes * 1000.0/fields.deltaMS);
        fields.deltaBitsPerSec     = Math.floor(fields.deltaBytes * 1000.0/fields.deltaMS * 8);
        fields.deltaPacketsPerSec  = Math.floor(fields.deltaPackets * 1000.0/fields.deltaMS);
        fields.deltaSessionsPerSec = Math.floor(fields.deltaSessions * 1000.0/fields.deltaMS);
        fields.deltaDroppedPerSec  = Math.floor(fields.deltaDropped * 1000.0/fields.deltaMS);
        data[pos] = mult * (fields[req.query.name] || 0);
      }
    }
    res.send(data);
  });
});

app.get('/:nodeName/:fileNum/filesize.json', function(req, res) {
  Db.fileIdToFile(req.params.nodeName, req.params.fileNum, function(file) {
    if (!file) {
      return res.send({filesize: -1});
    }

    fs.stat(file.name, function (err, stats) {
      if (err || !stats) {
        return res.send({filesize: -1});
      } else {
        return res.send({filesize: stats.size});
      }
    });
  });
});

app.get('/files.json', function(req, res) {
  noCache(req, res);

  var columns = ["num", "node", "name", "locked", "first", "filesize"];
  var limit = (req.query.iDisplayLength?Math.min(parseInt(req.query.iDisplayLength, 10),10000):500);

  var query = {_source: columns,
               from: req.query.iDisplayStart || 0,
               size: limit
              };

  addSortToQuery(query, req.query, "num");

  async.parallel({
    files: function (cb) {
      Db.search('files', 'file', query, function(err, result) {
        if (err || result.error) {
          return cb(err || result.error);
        }

        var results = {total: result.hits.total, results: []};
        for (var i = 0, ilen = result.hits.hits.length; i < ilen; i++) {
          var fields = result.hits.hits[i]._source || result.hits.hits[i].fields;
          if (fields.locked === undefined) {
            fields.locked = 0;
          }
          fields.id = result.hits.hits[i]._id;
          results.results.push(fields);
        }

        async.forEach(results.results, function (item, cb) {
          if (item.filesize && item.filesize !== 0) {
            return cb(null);
          }

          isLocalView(item.node, function () {
            fs.stat(item.name, function (err, stats) {
              if (err || !stats) {
                item.filesize = -1;
              } else {
                item.filesize = stats.size;
                if (item.locked) {
                  Db.updateFileSize(item, stats.size);
                }
              }
              cb(null);
            });
          }, function () {
            item.filesize = -2;
            cb(null);
          });
        }, function (err) {
          cb(null, results);
        });
      });
    },
    total: function (cb) {
      Db.numberOfDocuments('files', cb);
    }
  },
  function(err, results) {
    if (err) {
      return res.send({total: 0, results: []});
    }

    var r = {sEcho: req.query.sEcho,
             iTotalRecords: results.total,
             iTotalDisplayRecords: results.files.total,
             aaData: results.files.results};
    res.send(r);
  });
});


internals.usersMissing = {
  userName: "",
  enabled: "F",
  createEnabled: "F",
  webEnabled: "F",
  headerAuthEnabled: "F",
  emailSearch: "F",
  removeEnabled: "F",
  expression: ""
};
app.post('/users.json', function(req, res) {
  var columns = ["userId", "userName", "expression", "enabled", "createEnabled", "webEnabled", "headerAuthEnabled", "emailSearch", "removeEnabled"];
  var limit = (req.body.iDisplayLength?Math.min(parseInt(req.body.iDisplayLength, 10),10000):500);

  var query = {_source: columns,
               from: req.body.iDisplayStart || 0,
               size: limit
              };

  addSortToQuery(query, req.body, "userId", internals.usersMissing);

  async.parallel({
    users: function (cb) {
      Db.searchUsers(query, function(err, result) {
        if (err || result.error) {
          res.send({total: 0, results: []});
        } else {
          var results = {total: result.hits.total, results: []};
          for (var i = 0, ilen = result.hits.hits.length; i < ilen; i++) {
            var fields = result.hits.hits[i]._source || result.hits.hits[i].fields;
            fields.id = result.hits.hits[i]._id;
            fields.expression = safeStr(fields.expression || "");
            fields.headerAuthEnabled = fields.headerAuthEnabled || false;
            fields.emailSearch = fields.emailSearch || false;
            fields.removeEnabled = fields.removeEnabled || false;
            fields.userName = safeStr(fields.userName || "");
            results.results.push(fields);
          }
          cb(null, results);
        }
      });
    },
    total: function (cb) {
      Db.numberOfUsers(cb);
    }
  },
  function(err, results) {
    var r = {sEcho: req.body.sEcho,
             iTotalRecords: results.total,
             iTotalDisplayRecords: results.users.total,
             aaData: results.users.results};
    res.send(r);
  });
});

function mapMerge(aggregations) {
  var map = {src: {}, dst: {}};
  if (!aggregations || !aggregations.g1) {
    return {};
  }

  aggregations.g1.buckets.forEach(function (item) {
    map.src[item.key] = item.doc_count;
  });

  aggregations.g2.buckets.forEach(function (item) {
    map.dst[item.key] = item.doc_count;
  });

  return map;
}

function graphMerge(req, query, aggregations) {
  var graph = {
    lpHisto: [],
    dbHisto: [],
    paHisto: [],
    xmin: req.query.startTime * 1000|| null,
    xmax: req.query.stopTime * 1000 || null,
    interval: query.aggregations?query.aggregations.dbHisto.histogram.interval || 60 : 60
  };

  if (!aggregations || !aggregations.dbHisto) {
    return graph;
  }

  aggregations.dbHisto.buckets.forEach(function (item) {
    var key = item.key*1000;
    graph.lpHisto.push([key, item.doc_count]);
    graph.paHisto.push([key, item.pa.value]);
    graph.dbHisto.push([key, item.db.value]);
  });
  return graph;
}

app.get('/sessions.json', function(req, res) {
  var i;

  var graph = {};
  var map = {};
  buildSessionQuery(req, function(bsqErr, query, indices) {
    if (bsqErr) {
      var r = {sEcho: req.query.sEcho,
               iTotalRecords: 0,
               iTotalDisplayRecords: 0,
               graph: graph,
               map: map,
               bsqErr: bsqErr.toString(),
               aaData:[]};
      res.send(r);
      return;
    }
    query._source = ["pr", "ro", "db", "fp", "lp", "a1", "p1", "a2", "p2", "pa", "by", "no", "us", "g1", "g2", "esub", "esrc", "edst", "efn", "dnsho", "tls", "ircch"];

    if (query.aggregations && query.aggregations.dbHisto) {
      graph.interval = query.aggregations.dbHisto.histogram.interval;
    }

    console.log("sessions.json query", JSON.stringify(query));

    async.parallel({
      sessions: function (sessionsCb) {
        Db.searchPrimary(indices, 'session', query, function(err, result) {
          if (Config.debug) {
            console.log("sessions.json result", util.inspect(result, false, 50));
          }
          if (err || result.error) {
            console.log("sessions.json error", err, (result?result.error:null));
            sessionsCb(null, {total: 0, results: []});
            return;
          }

          graph = graphMerge(req, query, result.aggregations);
          map = mapMerge(result.aggregations);

          var results = {total: result.hits.total, results: []};
          var hits = result.hits.hits;
          for (var i = 0, ilen = hits.length; i < ilen; i++) {
            if (!hits[i]) {
              continue;
            }
            var fields = hits[i]._source || hits[i].fields;
            if (!fields) {
              continue;
            }
            fields.index = hits[i]._index;
            fields.id = hits[i]._id;
            results.results.push(fields);
          }
          sessionsCb(null, results);
        });
      },
      total: function (totalCb) {
        Db.numberOfDocuments('sessions-*', totalCb);
      },
      health: Db.healthCache
    },
    function(err, results) {
      var r = {sEcho: req.query.sEcho,
               iTotalRecords: results.total,
               iTotalDisplayRecords: (results.sessions?results.sessions.total:0),
               graph: graph,
               health: results.health,
               map: map,
               aaData: (results.sessions?results.sessions.results:[])};
      try {
        res.send(r);
      } catch (c) {
      }
    });
  });
});

app.get('/spigraph.json', function(req, res) {
  req.query.facets = 1;
  buildSessionQuery(req, function(bsqErr, query, indices) {
    var results = {items: [], graph: {}, map: {}, iTotalReords: 0};
    if (bsqErr) {
      results.bsqErr = bsqErr.toString();
      res.send(results);
      return;
    }

    delete query.sort;
    query.size = 0;
    var size = +req.query.size || 20;

    var field = req.query.field || "no";
    query.aggregations.field = {terms: {field: field, size: size}};

    /* Need the setImmediate so we don't blow max stack frames */
    var eachCb;
    switch (fmenum(field)) {
    case FMEnum.other:
      eachCb = function (item, cb) {setImmediate(cb);};
      break;
    case FMEnum.ip:
      eachCb = function(item, cb) {
        item.name = Pcap.inet_ntoa(item.name);
        setImmediate(cb);
      };
      break;
    case FMEnum.tags:
      eachCb = function(item, cb) {
        Db.tagIdToName(item.name, function (name) {
          item.name = name;
          setImmediate(cb);
        });
      };
      break;
    case FMEnum.hh:
      eachCb = function(item, cb) {
        Db.tagIdToName(item.name, function (name) {
          item.name = name.substring(12);
          setImmediate(cb);
        });
      };
      break;
    }

    Db.healthCache(function(err, health) {results.health = health;});
    Db.numberOfDocuments('sessions-*', function (err, total) {results.iTotalRecords = total;});
    Db.searchPrimary(indices, 'session', query, function(err, result) {
      if (err || result.error) {
        results.bsqErr = errorString(err, result);
        console.log("spigraph.json error", err, (result?result.error:null));
        return res.send(results);
      }
      results.iTotalDisplayRecords = result.hits.total;

      results.graph = graphMerge(req, query, result.aggregations);
      results.map = mapMerge(result.aggregations);

      if (!result.aggregations) {
        result.aggregations = {field: {buckets: []}};
      }

      var facets = result.aggregations.field.buckets;
      var interval = query.aggregations.dbHisto.histogram.interval;
      var filter;

      if (query.query.filtered.filter === undefined) {
        query.query.filtered.filter = {term: {}};
        filter = query.query.filtered.filter;
      } else {
        query.query.filtered.filter = {bool: {must: [{term: {}}, query.query.filtered.filter]}};
        filter = query.query.filtered.filter.bool.must[0];
      }

      delete query.aggregations.field;

      var queries = [];
      facets.forEach(function(item) {
        filter.term[field] = item.key;
        queries.push(JSON.stringify(query));
      });

      Db.msearch(indices, 'session', queries, function(err, result) {
        if (!result.responses) {
          return res.send(results);
        }

        result.responses.forEach(function(item, i) {
          var r = {name: facets[i].key, count: facets[i].doc_count};

          r.graph = graphMerge(req, query, result.responses[i].aggregations);
          if (r.graph.xmin === null) {
            r.graph.xmin = results.graph.xmin || results.graph.paHisto[0][0];
          }

          if (r.graph.xmax === null) {
            r.graph.xmax = results.graph.xmax || results.graph.paHisto[results.graph.paHisto.length-1][0];
          }

          r.map = mapMerge(result.responses[i].aggregations);
          eachCb(r, function () {
            results.items.push(r);
            if (results.items.length === result.responses.length) {
              results.items = results.items.sort(function(a,b) {return b.count - a.count;});
              return res.send(results);
            }
          });
        });
      });
    });
  });
});

app.get('/spiview.json', function(req, res) {
  if (req.query.spi === undefined) {
    return res.send({spi:{}, iTotalRecords: 0, iTotalDisplayRecords: 0});
  }

  var spiDataMaxIndices = +Config.get("spiDataMaxIndices", 1);

  if (req.query.date === '-1' && spiDataMaxIndices !== -1) {
    return res.send({spi: {}, bsqErr: "'All' date range not allowed for spiview query"});
  }

  buildSessionQuery(req, function(bsqErr, query, indices) {
    if (bsqErr) {
      var r = {spi: {},
               bsqErr: bsqErr.toString()
               };
      return res.send(r);
    }

    delete query.sort;

    if (!query.facets) {
      query.facets = {};
    }

    req.query.spi.split(",").forEach(function (item) {
      var parts = item.split(":");
      query.facets[parts[0]] = {terms: {field: parts[0], size:parseInt(parts[1], 10)}};
    });
    query.size = 0;

    console.log("spiview.json query", JSON.stringify(query), "indices", indices);

    var graph;
    var map;

    var indicesa = indices.split(",");
    if (spiDataMaxIndices !== -1 && indicesa.length > spiDataMaxIndices) {
      bsqErr = "To save ES from blowing up, reducing number of spi data indices searched from " + indicesa.length + " to " + spiDataMaxIndices + ".  This can be increased by setting spiDataMaxIndices in the config file.  Indices being searched: ";
      indices = indicesa.slice(-spiDataMaxIndices).join(",");
      bsqErr += indices;
    }

    var iTotalDisplayRecords = 0;

    async.parallel({
      spi: function (sessionsCb) {
        Db.searchPrimary(indices, 'session', query, function(err, result) {
          if (Config.debug) {
            console.log("spiview.json result", util.inspect(result, false, 50));
          }
          if (err || result.error) {
            bsqErr = errorString(err, result);
            console.log("spiview.json ERROR", err, (result?result.error:null));
            sessionsCb(null, {});
            return;
          }

          iTotalDisplayRecords = result.hits.total;

          if (!result.facets) {
            result.facets = {};
            for (var spi in query.facets) {
              result.facets[spi] = {_type: "terms", missing: 0, total: 0, other: 0, terms: []};
            }
          }

          if (!result.aggregations) {
            result.aggregations = {};
          }

          if (result.facets.pr) {
            result.facets.pr.terms.forEach(function (item) {
              item.term = Pcap.protocol2Name(item.term);
            });
          }

          if (req.query.facets) {
            graph = graphMerge(req, query, result.aggregations);
            map = mapMerge(result.aggregations);
          }
          delete result.aggregations.dbHisto;
          delete result.aggregations.paHisto;
          delete result.aggregations.g1;
          delete result.aggregations.g2;

          sessionsCb(null, result.facets);
        });
      },
      total: function (totalCb) {
        Db.numberOfDocuments('sessions-*', totalCb);
      },
      health: Db.healthCache
    },
    function(err, results) {
      function tags(container, field, doneCb, offset) {
        if (!container[field]) {
          return doneCb(null);
        }
        async.map(container[field].terms, function (item, cb) {
          Db.tagIdToName(item.term, function (name) {
            item.term = name.substring(offset);
            cb(null, item);
          });
        },
        function(err, tagsResults) {
          container[field].terms = tagsResults;
          doneCb(err);
        });
      }

      async.parallel([
        function(parallelCb) {
          tags(results.spi, "ta", parallelCb, 0);
        },
        function(parallelCb) {
          tags(results.spi, "hh", parallelCb, 12);
        },
        function(parallelCb) {
          tags(results.spi, "hh1", parallelCb, 12);
        },
        function(parallelCb) {
          tags(results.spi, "hh2", parallelCb, 12);
        }],
        function() {
          r = {health: results.health,
               iTotalRecords: results.total,
               spi: results.spi,
               iTotalDisplayRecords: iTotalDisplayRecords,
               graph: graph,
               map: map,
               bsqErr: bsqErr
          };
          try {
            res.send(r);
          } catch (c) {
          }
        }
      );
    });
  });
});

app.get('/dns.json', function(req, res) {
  console.log("dns.json", req.query);
  dns.reverse(req.query.ip, function (err, data) {
    if (err) {
      return res.send({hosts: []});
    }
    return res.send({hosts: data});
  });
});

function buildConnections(req, res, cb) {
  if (req.query.dstField === "ip.dst:port") {
    var dstipport = true;
    req.query.dstField = "a2";
  }

  req.query.srcField       = req.query.srcField || "a1";
  req.query.dstField       = req.query.dstField || "a2";
  var fsrc                 = req.query.srcField.replace(".snow", "");
  var fdst                 = req.query.dstField.replace(".snow", "");
  var minConn              = req.query.minConn  || 1;
  req.query.iDisplayLength = req.query.iDisplayLength || "5000";

  var nodesHash = {};
  var connects = {};
  var tsrc = fmenum(fsrc);
  var tdst = fmenum(fdst);

  function process(vsrc, vdst, f, cb) {
    if (nodesHash[vsrc] === undefined) {
      nodesHash[vsrc] = {id: ""+vsrc, db: 0, by: 0, pa: 0, cnt: 0, sessions: 0};
    }

    nodesHash[vsrc].sessions++;
    nodesHash[vsrc].by += f.by;
    nodesHash[vsrc].db += f.db;
    nodesHash[vsrc].pa += f.pa;
    nodesHash[vsrc].type |= 1;

    if (nodesHash[vdst] === undefined) {
      nodesHash[vdst] = {id: ""+vdst, db: 0, by: 0, pa: 0, cnt: 0, sessions: 0};
    }

    nodesHash[vdst].sessions++;
    nodesHash[vdst].by += f.by;
    nodesHash[vdst].db += f.db;
    nodesHash[vdst].pa += f.pa;
    nodesHash[vdst].type |= 2;

    var n = "" + vsrc + "->" + vdst;
    if (connects[n] === undefined) {
      connects[n] = {value: 0, source: vsrc, target: vdst, by: 0, db: 0, pa: 0, no: {}};
      nodesHash[vsrc].cnt++;
      nodesHash[vdst].cnt++;
    }

    connects[n].value++;
    connects[n].by += f.by;
    connects[n].db += f.db;
    connects[n].pa += f.pa;
    connects[n].no[f.no] = 1;
    return setImmediate(cb);
  }

  function processDst(vsrc, adst, f, cb) {
    async.each(adst, function(vdst, dstCb) {
      if (tdst === FMEnum.other) {
        process(vsrc, vdst, f, dstCb);
      } else if (tdst === FMEnum.ip) {
        vdst = Pcap.inet_ntoa(vdst);
        if (dstipport) {
          vdst += ":" + f.p2;
        }
        process(vsrc, vdst, f, dstCb);
      } else {
        Db.tagIdToName(vdst, function (name) {
          if (tdst === FMEnum.tags) {
            vdst = name;
          } else {
            vdst = name.substring(12);
          }
          process(vsrc, vdst, f, dstCb);
        });
      }
    }, function (err) {
      return setImmediate(cb);
    });
  }

  buildSessionQuery(req, function(bsqErr, query, indices) {
    if (bsqErr) {
      return cb(bsqErr, 0, 0, 0);
    }

    if (query.query.filtered.filter === undefined) {
      query.query.filtered.filter = {bool: {must: [{exists: {field: req.query.srcField}}, {exists: {field: req.query.dstField}}]}};
    } else {
      query.query.filtered.filter = {bool: {must: [query.query.filtered.filter, {exists: {field: req.query.srcField}}, {exists: {field: req.query.dstField}}]}};
    }

    query._source = ["by", "db", "pa", "no"];
    query.fields=[fsrc, fdst];
    if (dstipport) {
      query._source.push("p2");
    }

    console.log("buildConnections query", JSON.stringify(query));

    Db.searchPrimary(indices, 'session', query, function (err, graph) {
      if (err || graph.error) {
        console.log("Build Connections ERROR", err, graph.error);
        return cb(err || graph.error);
      }
      var i;

      async.eachLimit(graph.hits.hits, 10, function(hit, hitCb) {
        var f = hit._source;

        var asrc = hit.fields[fsrc];
        var adst = hit.fields[fdst];


        if (asrc === undefined || adst === undefined) {
          return setImmediate(hitCb);
        }

        if (!Array.isArray(asrc)) {
          asrc = [asrc];
        }

        if (!Array.isArray(adst)) {
          adst = [adst];
        }

        async.each(asrc, function(vsrc, srcCb) {
          if (tsrc === FMEnum.other) {
            processDst(vsrc, adst, f, srcCb);
          } else if (tsrc === FMEnum.ip) {
            vsrc = Pcap.inet_ntoa(vsrc);
            processDst(vsrc, adst, f, srcCb);
          } else {
            Db.tagIdToName(vsrc, function (name) {
              if (tsrc === FMEnum.tags) {
                vsrc = name;
              } else {
                vsrc = name.substring(12);
              }
              processDst(vsrc, adst, f, srcCb);
            });
          }
        }, function (err) {
          setImmediate(hitCb);
        });
      }, function (err) {
        var nodes = [];
        for (var node in nodesHash) {
          if (nodesHash[node].cnt < minConn) {
            nodesHash[node].pos = -1;
          } else {
            nodesHash[node].pos = nodes.length;
            nodes.push(nodesHash[node]);
          }
        }


        var links = [];
        for (var key in connects) {
          var c = connects[key];
          c.source = nodesHash[c.source].pos;
          c.target = nodesHash[c.target].pos;
          if (c.source >= 0 && c.target >= 0) {
            links.push(connects[key]);
          }
        }

        //console.log("nodesHash", nodesHash);
        //console.log("connects", connects);
        //console.log("nodes", nodes.length, nodes);
        //console.log("links", links.length, links);

        return cb(null, nodes, links, graph.hits.total);
      });
    });
  });
}

app.get('/connections.json', function(req, res) {
  var health;
  Db.healthCache(function(err, h) {health = h;});
  buildConnections(req, res, function (err, nodes, links, total) {
    if (err) {
      return res.send({health: health, bsqErr: err.toString()});
    }
    res.send({health: health, nodes: nodes, links: links, iTotalDisplayRecords: total});
  });
});

app.get('/connections.csv', function(req, res) {
  res.setHeader("Content-Type", "application/force-download");
  var seperator = req.query.seperator || ",";
  buildConnections(req, res, function (err, nodes, links, total) {
    if (err) {
      return res.send(err);
    }

    res.write("Source, Destination, Sessions, Packets, Bytes, Databytes\r\n");
    for (var i = 0, ilen = links.length; i < ilen; i++) {
      res.write("\"" + nodes[links[i].source].id.replace('"', '""') + "\"" + seperator +
                "\"" + nodes[links[i].target].id.replace('"', '""') + "\"" + seperator +
                     links[i].value + seperator +
                     links[i].pa + seperator +
                     links[i].by + seperator +
                     links[i].db + "\r\n");
    }
    res.end();
  });
});

function csvListWriter(req, res, list, pcapWriter, extension) {
  if (list.length > 0 && list[0].fields) {
    list = list.sort(function(a,b){return a.fields.lp - b.fields.lp;});
  } else if (list.length > 0 && list[0]._source) {
    list = list.sort(function(a,b){return a._source.lp - b._source.lp;});
  }

  res.write("Protocol, First Packet, Last Packet, Source IP, Source Port, Source Geo, Destination IP, Destination Port, Destination Geo, Packets, Bytes, Data Bytes, Node\r\n");

  for (var i = 0, ilen = list.length; i < ilen; i++) {
    var fields = list[i]._source || list[i].fields;

    if (!fields) {
      continue;
    }
    var pr;
    switch (fields.pr) {
    case 1:
      pr = "icmp";
      break;
    case 6:
      pr = "tcp";
      break;
    case 17:
      pr =  "udp";
      break;
    }


    res.write(pr + ", " + fields.fp + ", " + fields.lp + ", " + Pcap.inet_ntoa(fields.a1) + ", " + fields.p1 + ", " + (fields.g1||"") + ", "  + Pcap.inet_ntoa(fields.a2) + ", " + fields.p2 + ", " + (fields.g2||"") + ", " + fields.pa + ", " + fields.by + ", " + fields.db + ", " + fields.no + "\r\n");
  }
  res.end();
}

app.get(/\/sessions.csv.*/, function(req, res) {
  noCache(req, res, "text/csv");
  var fields = ["pr", "fp", "lp", "a1", "p1", "g1", "a2", "p2", "g2", "by", "db", "pa", "no"];

  if (req.query.ids) {
    var ids = req.query.ids.split(",");

    sessionsListFromIds(req, ids, fields, function(err, list) {
      csvListWriter(req, res, list);
    });
  } else {
    sessionsListFromQuery(req, res, fields, function(err, list) {
      csvListWriter(req, res, list);
    });
  }
});

app.get('/uniqueValue.json', function(req, res) {
  noCache(req, res);
  var query;

  if (req.query.type === "tags") {
    query = {bool: {must: {wildcard: {_id: req.query.filter + "*"}},
                  must_not: {wildcard: {_id: "http:header:*"}}
                     }
          };
  } else {
    query = {wildcard: {_id: "http:header:" + req.query.filter + "*"}};
  }

  console.log("uniqueValue query", JSON.stringify(query));
  Db.search('tags', 'tag', {size:200, query: query}, function(err, result) {
    var terms = [];
    if (req.query.type === "tags") {
      result.hits.hits.forEach(function (hit) {
        terms.push(hit._id);
      });
    } else {
      result.hits.hits.forEach(function (hit) {
        terms.push(hit._id.substring(12));
      });
    }
    res.send(terms);
  });
});

app.get('/unique.txt', function(req, res) {
  if (req.query.field === undefined) {
    return res.send("Missing field parameter");
  }

  noCache(req, res);

  /* How should the results be written.  Use setImmediate to not blow stack frame */
  var writeCb;
  var writes = 0;
  if (parseInt(req.query.counts, 10) || 0) {
    writeCb = function (item, cb) {
      res.write("" + item.term + ", " + item.count + "\n");
      if (writes++ > 1000) {
        writes = 0;
        setImmediate(cb);
      } else {
        cb();
      }
    };
  } else {
    writeCb = function (item, cb) {
      res.write("" + item.term + "\n");
      if (writes++ > 1000) {
        writes = 0;
        setImmediate(cb);
      } else {
        cb();
      }
    };
  }

  /* How should each item be processed. */
  var eachCb;
  switch (fmenum(req.query.field)) {
  case FMEnum.other:
    eachCb = writeCb;
    break;
  case FMEnum.ip:
    eachCb = function(item, cb) {
      item.term = Pcap.inet_ntoa(item.term);
      writeCb(item, cb);
    };
    break;
  case FMEnum.tags:
    eachCb = function(item, cb) {
      Db.tagIdToName(item.term, function (name) {
        item.term = name;
        writeCb(item, cb);
      });
    };
    break;
  case FMEnum.hh:
    eachCb = function(item, cb) {
      Db.tagIdToName(item.term, function (name) {
        item.term = name.substring(12);
        writeCb(item, cb);
      });
    };
    break;
  }

  buildSessionQuery(req, function(err, query, indices) {
    delete query.sort;
    delete query.facets;

    if (req.query.field.match(/^(rawus|rawua)$/)) {
      var field = req.query.field.substring(3);
      query.size   = 200000;

      query._source = [field];

      if (query.query.filtered.filter === undefined) {
        query.query.filtered.filter = {exists: {field: field}};
      } else {
        query.query.filtered.filter = {and: [query.query.filtered.filter, {exists: {field: field}}]};
      }

      console.log("unique query", indices, JSON.stringify(query));
      Db.searchPrimary(indices, 'session', query, function(err, result) {
        var counts = {};

        // Count up hits
        var hits = result.hits.hits;
        for (var i = 0, ilen = hits.length; i < ilen; i++) {
          var fields = hits[i]._source || hits[i].fields;
          var avalue = fields[field];
          if (Array.isArray(avalue)) {
            for (var j = 0, jlen = avalue.length; j < jlen; j++) {
              var value = avalue[j];
              counts[value] = (counts[value] || 0) + 1;
            }
          } else {
            counts[avalue] = (counts[avalue] || 0) + 1;
          }
        }

        // Change to facet looking array
        var facets = [];
        for (var key in counts) {
          facets.push({term: key, count: counts[key]});
        }

        async.forEachSeries(facets, eachCb, function () {
          res.end();
        });
      });
    } else {
      console.log("unique facet", indices, JSON.stringify(query));
      query.facets = {facets: { terms : {field : req.query.field, size: 1000000}}};
      query.size = 0;
      Db.searchPrimary(indices, 'session', query, function(err, result) {
        async.forEachSeries(result.facets.facets.terms, eachCb, function () {
          res.end();
        });
      });
    }
  });
});

function processSessionIdDisk(session, headerCb, packetCb, endCb, limit) {
  function processFile(pcap, pos, i, nextCb) {
    pcap.ref();
    pcap.readPacket(pos, function(packet) {
      switch(packet) {
      case null:
        endCb("Error loading data for session " + session._id, null);
        break;
      case undefined:
        break;
      default:
        packetCb(pcap, packet, nextCb, i);
        break;
      }
      pcap.unref();
    });
  }

  var fields;

  fields = session._source || session.fields;

  var fileNum;
  var itemPos = 0;
  async.eachLimit(fields.ps, limit || 1, function(pos, nextCb) {
    if (pos < 0) {
      fileNum = pos * -1;
      return nextCb(null);
    }

    // Get the pcap file for this node a filenum, if it isn't opened then do the filename lookup and open it
    var opcap = Pcap.get(fields.no + ":" + fileNum);
    if (!opcap.isOpen()) {
      Db.fileIdToFile(fields.no, fileNum, function(file) {

        if (!file) {
          console.log("WARNING - Only have SPI data, PCAP file no longer available", fields.no + '-' + fileNum);
          return nextCb("Only have SPI data, PCAP file no longer available for " + fields.no + '-' + fileNum);
        }

        var ipcap = Pcap.get(fields.no + ":" + file.num);

        try {
          ipcap.open(file.name);
        } catch (err) {
          console.log("ERROR - Couldn't open file ", err);
          return nextCb("Couldn't open file " + err);
        }

        if (headerCb) {
          headerCb(ipcap, ipcap.readHeader());
          headerCb = null;
        }
        processFile(ipcap, pos, itemPos++, nextCb);
      });
    } else {
      if (headerCb) {
        headerCb(opcap, opcap.readHeader());
        headerCb = null;
      }
      processFile(opcap, pos, itemPos++, nextCb);
    }
  },
  function (pcapErr, results) {
    endCb(pcapErr, fields);
  });
}

function processSessionId(id, fullSession, headerCb, packetCb, endCb, maxPackets, limit) {
  var options;
  if (!fullSession) {
    options  = {fields: "no,ps,psl"};
  }

  Db.getWithOptions(Db.id2Index(id), 'session', id, options, function(err, session) {
    if (err || !session.found) {
      console.log("session get error", err, session);
      return endCb("Session not found", null);
    }

    var fields = session._source || session.fields;

    if (maxPackets && fields.ps.length > maxPackets) {
      fields.ps.length = maxPackets;
    }

    /* Go through the list of prefetch the id to file name if we are running in parallel to
     * reduce the number of elasticsearch queries and problems
     */
    var outstanding = 0;
    var saveInfo;
    for (var i = 0, ilen = fields.ps.length; i < ilen; i++) {
      if (fields.ps[i] < 0) {
        outstanding++;
        Db.fileIdToFile(fields.no, -1 * fields.ps[i], function (info) {
          outstanding--;
          if (i === 0) {
            saveInfo = info;
          }
          if (i === ilen && outstanding === 0) {
            i++; // So not called again below
            readyToProcess();
          }
        });
      }
    }

    if (i === ilen && outstanding === 0) {
      readyToProcess();
    }

    function readyToProcess() {
      var pcapWriteMethod = Config.getFull(fields.no, "pcapWriteMethod");
      var psid = processSessionIdDisk;
      var writer = internals.writers[pcapWriteMethod];
      if (writer && writer.processSessionId) {
        psid = writer.processSessionId;
      }

      psid(session, headerCb, packetCb, function (err, fields) {
        if (!fields) {
          return endCb(err, fields);
        }

        function tags(container, field, doneCb, offset) {
          if (!container[field]) {
            return doneCb(null);
          }
          async.map(container[field], function (item, cb) {
            Db.tagIdToName(item, function (name) {
              cb(null, name.substring(offset));
            });
          },
          function(err, results) {
            container[field] = results;
            doneCb(err);
          });
        }

        async.parallel([
          function(parallelCb) {
            if (!fields.ta) {
              fields.ta = [];
              return parallelCb(null);
            }
            tags(fields, "ta", parallelCb, 0);
          },
          function(parallelCb) {
            tags(fields, "hh", parallelCb, 12);
          },
          function(parallelCb) {
            tags(fields, "hh1", parallelCb, 12);
          },
          function(parallelCb) {
            tags(fields, "hh2", parallelCb, 12);
          },
          function(parallelCb) {
            var files = [];
            if (!fields.fs) {
              fields.fs = [];
              return parallelCb(null);
            }
            async.forEachSeries(fields.fs, function (item, cb) {
              Db.fileIdToFile(fields.no, item, function (file) {
                if (file && file.locked === 1) {
                  files.push(file.name);
                }
                cb(null);
              });
            },
            function(err) {
              fields.fs = files;
              parallelCb(err);
            });
          }],
          function(err, results) {
            endCb(err, fields);
          }
        );
      }, limit);
    }
  });
}

function processSessionIdAndDecode(id, numPackets, doneCb) {
  var packets = [];
  processSessionId(id, true, null, function (pcap, buffer, cb, i) {
    var obj = {};
    if (buffer.length > 16) {
      pcap.decode(buffer, obj);
    } else {
      obj = {ip: {p: ""}};
    }
    packets[i] = obj;
    cb(null);
  },
  function(err, session) {
    if (err) {
      return doneCb("error");
    }
    packets = packets.filter(Boolean);
    if (packets.length === 0) {
      return doneCb(null, session, []);
    } else if (packets[0].ip === undefined) {
      return doneCb(null, session, []);
    } else if (packets[0].ip.p === 1) {
      Pcap.reassemble_icmp(packets, function(err, results) {
        return doneCb(err, session, results);
      });
    } else if (packets[0].ip.p === 6) {
      Pcap.reassemble_tcp(packets, Pcap.inet_ntoa(session.a1) + ':' + session.p1, function(err, results) {
        return doneCb(err, session, results);
      });
    } else if (packets[0].ip.p === 17) {
      Pcap.reassemble_udp(packets, function(err, results) {
        return doneCb(err, session, results);
      });
    } else {
      return doneCb(null, session, []);
    }
  },
  numPackets, 10);
}

// Some ideas from hexy.js
function toHex(input, offsets) {
  var out = "";
  var i, ilen;

  for (var pos = 0, poslen = input.length; pos < poslen; pos += 16) {
    var line = input.slice(pos, Math.min(pos+16, input.length));
    if (offsets) {
      out += sprintf.sprintf("<span class=\"sessionln\">%08d:</span> ", pos);
    }

    for (i = 0; i < 16; i++) {
      if (i % 2 === 0 && i > 0) {
        out += " ";
      }
      if (i < line.length) {
        out += sprintf.sprintf("%02x", line[i]);
      } else {
        out += "  ";
      }
    }

    out += " ";

    for (i = 0, ilen = line.length; i < ilen; i++) {
      if (line[i] <= 32 || line[i]  > 128) {
        out += ".";
      } else {
        out += safeStr(line.toString("ascii", i, i+1));
      }
    }
    out += "\n";
  }
  return out;
}

// Modified version of https://gist.github.com/penguinboy/762197
function flattenObject1 (obj) {
  var toReturn = {};

  for (var i in obj) {
    if (!obj.hasOwnProperty(i)) {
      continue;
    }

    if ((typeof obj[i]) === 'object' && !Array.isArray(obj[i])) {
      for (var x in obj[i]) {
        if (!obj[i].hasOwnProperty(x)) {
          continue;
        }

        toReturn[i + '.' + x] = obj[i][x];
      }
    } else {
      toReturn[i] = obj[i];
    }
  }
  return toReturn;
}

function localSessionDetailReturnFull(req, res, session, incoming) {
  var outgoing = [];
  for (var r = 0, rlen = incoming.length; r < rlen; r++) {
    outgoing[r]= {ts: incoming[r].ts, html: "", bytes:0};
    for (var p = 0, plen = incoming[r].pieces.length; p < plen; p++) {
      outgoing[r].bytes += incoming[r].pieces[p].raw.length;
      if (req.query.base === "hex") {
        outgoing[r].html += '<pre>' + toHex(incoming[r].pieces[p].raw, req.query.line === "true") + '</pre>';
      } else if (req.query.base === "ascii") {
        outgoing[r].html += '<pre>' + safeStr(incoming[r].pieces[p].raw.toString("binary")) + '</pre>';
      } else if (req.query.base === "utf8") {
        outgoing[r].html += '<pre>' + safeStr(incoming[r].pieces[p].raw.toString("utf8")) + '</pre>';
      } else {
        outgoing[r].html += safeStr(incoming[r].pieces[p].raw.toString()).replace(/\r?\n/g, '<br>');
      }

      if(incoming[r].pieces[p].bodyNum !== undefined) {
        var url = req.params.nodeName + "/" +
                  session.id + "/body/" +
                  incoming[r].pieces[p].bodyType + "/" +
                  incoming[r].pieces[p].bodyNum + "/" +
                  incoming[r].pieces[p].bodyName + ".pellet";

        if (incoming[r].pieces[p].bodyType === "image") {
          outgoing[r].html += "<img src=\"" + url + "\">";
        } else {
          outgoing[r].html += "<a class='imagetag' href=\"" + url + "\">" + incoming[r].pieces[p].bodyName + "</a>";
        }
      }
    }
  }

  jade.render(internals.sessionDetail, {
    filename: "sessionDetail",
    user: req.user,
    session: session,
    data: outgoing,
    query: req.query,
    basedir: "/",
    reqFields: Config.headers("headers-http-request"),
    resFields: Config.headers("headers-http-response"),
    emailFields: Config.headers("headers-email")
  }, function(err, data) {
    if (err) {
      console.trace("ERROR - ", err);
      return req.next(err);
    }
    res.send(data);
  });
}


// Needs to be rewritten, this sucks
function gzipDecode(req, res, session, incoming) {
  var kind;

  var outgoing = [];

  if (incoming[0].data.slice(0,4).toString() === "HTTP") {
    kind = [HTTPParser.RESPONSE, HTTPParser.REQUEST];
  } else {
    kind = [HTTPParser.REQUEST, HTTPParser.RESPONSE];
  }
  var parsers = [new HTTPParser(kind[0]), new HTTPParser(kind[1])];

  parsers[0].onBody = parsers[1].onBody = function(buf, start, len) {
    //console.log("onBody", this.pos, this.gzip);
    var pos = this.pos;

    // This isn't a gziped request
    if (!this.gzip) {
      outgoing[pos] = {ts: incoming[pos].ts, pieces:[{raw: buf}]};
      return;
    }

    // Copy over the headers
    if (!outgoing[pos]) {
      outgoing[pos] = {ts: incoming[pos].ts, pieces:[{raw: buf.slice(0, start)}]};
    }

    if (!this.inflator) {
      this.inflator = zlib.createGunzip()
        .on("data", function (b) {
          var tmp = Buffer.concat([outgoing[pos].pieces[0].raw, new Buffer(b)]);
          outgoing[pos].pieces[0].raw = tmp;
        })
        .on("error", function (e) {
          outgoing[pos].pieces[0].raw = buf;
        })
        .on("end", function () {
        });
    }

    this.inflator.write(buf.slice(start,start+len));
  };

  parsers[0].onMessageComplete = parsers[1].onMessageComplete = function() {
    //console.log("onMessageComplete", this.pos, this.gzip);
    var pos = this.pos;

    if (pos > 0) {
      parsers[(pos+1)%2].reinitialize(kind[(pos+1)%2]);
    }

    var nextCb = this.nextCb;
    this.nextCb = null;
    if (this.inflator) {
      this.inflator.end(null, function () {
        setImmediate(nextCb);
      });
      this.inflator = null;
    } else {
      outgoing[pos] = {ts: incoming[pos].ts, pieces: [{raw: incoming[pos].data}]};
      if (nextCb) {
        setImmediate(nextCb);
      }
    }
  };

  parsers[0].onHeadersComplete = parsers[1].onHeadersComplete = function(info) {
    this.gzip = false;
    for (var h = 0, hlen = info.headers.length; h < hlen; h += 2) {
      // If Content-Type is gzip then stop, otherwise look for encoding
      if (info.headers[h].match(/Content-Type/i) && info.headers[h+1].match(/gzip/i)) {
        this.gzip = true;
        break;
      }

      // Seperate if since we break after 1 content-encoding no matter what
      if (info.headers[h].match(/Content-Encoding/i)) {
        if (info.headers[h+1].match(/gzip/i)) {
          this.gzip = true;
        }
        break;
      }
    }
    //console.log("onHeadersComplete", this.pos, this.gzip);
  };

  var p = 0;
  async.forEachSeries(incoming, function(item, nextCb) {
    var pos = p;
    p++;
    parsers[(pos%2)].pos = pos;

    if (!item) {
    } else if (item.data.length === 0) {
      outgoing[pos] = {ts: incoming[pos].ts, pieces:[{raw: item.data}]};
      setImmediate(nextCb);
    } else {
      parsers[(pos%2)].nextCb = nextCb;
      var out = parsers[(pos%2)].execute(item.data, 0, item.data.length);
      if (typeof out === "object") {
        outgoing[pos] = {ts: incoming[pos].ts, pieces:[{raw: item.data}]};
        console.log("ERROR", out);
      }
      if (parsers[(pos%2)].nextCb) {
        setImmediate(parsers[(pos%2)].nextCb);
        parsers[(pos%2)].nextCb = null;
      }
    }
  }, function (err) {
    req.query.needgzip = "false";
    parsers[0].finish();
    parsers[1].finish();
    setTimeout(localSessionDetailReturnFull, 100, req, res, session, outgoing);
  });
}

function imageDecodeHTTP(req, res, session, incoming, findBody) {
  var kind;

  if (incoming[0].data.slice(0,4).toString() === "HTTP") {
    kind = [HTTPParser.RESPONSE, HTTPParser.REQUEST];
  } else {
    kind = [HTTPParser.REQUEST, HTTPParser.RESPONSE];
  }
  var parsers = [new HTTPParser(kind[0]), new HTTPParser(kind[1])];

  var bodyNum = 0;
  var bodyType = "file";
  var foundBody = false;

  parsers[0].onBody = parsers[1].onBody = function(buf, start, len) {
    //console.log("onBody", this.pos, bodyNum, start, len, outgoing[this.pos]);
    if (findBody === bodyNum) {
      foundBody = true;
      return res.write(buf.slice(start, start+len));
    }

    var pos = this.pos;

    // Copy over the headers
    if (outgoing[pos] === undefined) {
      if (this.image) {
        outgoing[pos] = {ts: incoming[pos].ts, pieces: [{bodyNum: bodyNum, bodyType:"image", bodyName:"image" + bodyNum}]};
      } else {
        outgoing[pos] = {ts: incoming[pos].ts, pieces: [{bodyNum: bodyNum, bodyType:"file", bodyName:"file" + bodyNum}]};
      }
      outgoing[pos].pieces[0].raw = buf.slice(0, start);
    } else if (incoming[pos].data === undefined) {
      outgoing[pos].pieces[0].raw = new Buffer(0);
    }
  };

  parsers[0].onMessageComplete = parsers[1].onMessageComplete = function() {
    if (foundBody) {
      return res.end();
    }
    if (this.pos > 0 && this.hinfo && this.hinfo.statusCode !== 100) {
      parsers[(this.pos+1)%2].reinitialize(kind[(this.pos+1)%2]);
    }
    var pos = this.pos;

    //console.log("onMessageComplete", this.pos, outgoing[this.pos]);

    if (!outgoing[pos]) {
      outgoing[pos] = {ts: incoming[pos].ts, pieces: [{raw: incoming[pos].data}]};
    } else if (outgoing[pos].pieces && outgoing[pos].pieces[0].bodyNum !== undefined) {
      bodyNum++;
    }
  };

  parsers[0].onHeadersComplete = parsers[1].onHeadersComplete = function(info) {
    var pos = this.pos;
    this.hinfo = info;

    //console.log("onHeadersComplete", this.pos, info);

    this.image = false;
    for (var h = 0, hlen = info.headers.length; h < hlen; h += 2) {
      if (info.headers[h].match(/Content-Type/i)) {
        if (info.headers[h+1].match(/^image/i)) {
          this.image = true;
        }
        break;
      }
    }
  };

  var outgoing = [];

  var p = 0;
  async.forEachSeries(incoming, function(item, nextCb) {
    parsers[(p%2)].pos = p;
    //console.log("for", p);

    if (!item) {
    } else if (item.data.length === 0) {
      outgoing[p] = {ts: incoming[p].ts, pieces:[{raw: item.data}]};
    } else {
      var out = parsers[(p%2)].execute(item.data, 0, item.data.length);
      if (typeof out === "object") {
        outgoing[p] = {ts: incoming[p].ts, pieces:[{raw: item.data}]};
        console.log("ERROR", out);
      }

      if (!outgoing[p]) {
        outgoing[p] = {ts: incoming[p].ts, pieces: [{raw: incoming[p].data}]};
      }
    }

    if (res.finished === true) {
      return nextCb("Done!");
    } else {
      setImmediate(nextCb);
    }
    p++;
  }, function (err) {
    if (findBody === -1) {
      setImmediate(localSessionDetailReturnFull,req, res, session, outgoing);
    }
  });
}

function imageDecodeSMTP(req, res, session, incoming, findBody) {
  var outgoing = [];

  var STATES = {
    cmd: 1,
    header: 2,
    data: 3,
    mime: 4,
    mime_data: 5,
    ignore: 6
  };

  var states = [STATES.cmd, STATES.cmd];
  var bodyNum = 0;
  var bodyType = "file";
  var bodyName = "unknown";

  function parse(data, p) {
    var lines = data.toString("binary").replace(/\r?\n$/, '').split(/\r?\n|\r/);
    var state = states[p%2];
    var header = "";
    var mime;
    var boundaries = [];
    var pieces = [{raw: ""}];
    var matches;
    var b, blen;

    linesloop:
    for (var l = 0, llen = lines.length; l < llen; l++) {
      switch (state) {
      case STATES.cmd:
        pieces[pieces.length-1].raw += lines[l] + "\n";

        if (lines[l].toUpperCase() === "DATA") {
          state = STATES.header;
          header = "";
          boundaries = [];
        } else if (lines[l].toUpperCase() === "STARTTLS") {
          state = STATES.ignore;
        }
        break;
      case STATES.header:
        pieces[pieces.length-1].raw += lines[l] + "\n";
        if (lines[l][0] === " " || lines[l][0] === "\t") {
          header += lines[l];
          continue;
        }
        if (header.substr(0, 13).toLowerCase() === "content-type:") {
          if ((matches = header.match(/boundary\s*=\s*("?)([^"]*)\1/))) {
            boundaries.push(matches[2]);
          }
        }
        if (lines[l] === "") {
          state = STATES.data;
          continue;
        }
        header = lines[l];
        break;
      case STATES.data:
        pieces[pieces.length-1].raw += lines[l] + "\n";
        if (lines[l] === ".") {
          state = STATES.cmd;
          continue;
        }

        if (lines[l][0] === '-') {
          for (b = 0, blen = boundaries.length; b < blen; b++) {
            if (lines[l].substr(2, boundaries[b].length) === boundaries[b]) {
              state = STATES.mime;
              mime = {line:"", base64:0};
              continue linesloop;
            }
          }
        }
        break;
      case STATES.mime:
        if (lines[l] === ".") {
          state = STATES.cmd;
          continue;
        }

        pieces[pieces.length-1].raw += lines[l] + "\n";

        if (lines[l][0] === " " || lines[l][0] === "\t") {
          mime.line += lines[l];
          continue;
        }
        if (mime.line.substr(0, 13).toLowerCase() === "content-type:") {
          if ((matches = mime.line.match(/boundary\s*=\s*("?)([^"]*)\1/))) {
            boundaries.push(matches[2]);
          }
          if ((matches = mime.line.match(/name\s*=\s*("?)([^"]*)\1/))) {
            bodyName = matches[2];
          }

          if (mime.line.match(/content-type: image/i)) {
            bodyType = "image";
          }

        } else if (mime.line.match(/content-disposition:/i)) {
          if ((matches = mime.line.match(/filename\s*=\s*("?)([^"]*)\1/))) {
            bodyName = matches[2];
          }
        } else if (mime.line.match(/content-transfer-encoding:.*base64/i)) {
          mime.base64 = 1;
          mime.doit = 1;
        }
        if (lines[l] === "") {
          if (mime.doit) {
            pieces[pieces.length-1].bodyNum = bodyNum+1;
            pieces[pieces.length-1].bodyType = bodyType;
            pieces[pieces.length-1].bodyName = bodyName;
            pieces.push({raw: ""});
            bodyType = "file";
            bodyName = "unknown";
            bodyNum++;
          }
          state = STATES.mimedata;
          continue;
        }
        mime.line = lines[l];
        break;
      case STATES.mimedata:
        if (lines[l] === ".") {
          if (findBody === bodyNum) {
            return res.end();
          }
          state = STATES.cmd;
          continue;
        }

        if (lines[l][0] === '-') {
          for (b = 0, blen = boundaries.length; b < blen; b++) {
            if (lines[l].substr(2, boundaries[b].length) === boundaries[b]) {
              if (findBody === bodyNum) {
                return res.end();
              }
              state = STATES.mime;
              mime = {line:"", base64:0};
              continue linesloop;
            }
          }
        }

        if (!mime.doit) {
          pieces[pieces.length-1].raw += lines[l] + "\n";
        } else if (findBody === bodyNum) {
          res.write(new Buffer(lines[l], 'base64'));
        }
        break;
      }
    }
    states[p%2] = state;

    return pieces;
  }

  for (var p = 0, plen = incoming.length; p < plen; p++) {
    if (incoming[p].data.length === 0) {
      outgoing[p] = {ts: incoming[p].ts, pieces:[{raw: incoming[p].data}]};
    } else {
      outgoing[p] = {ts: incoming[p].ts, pieces: parse(incoming[p].data, p)};
    }
    if (res.finished === true) {
      break;
    }
  }

  if (findBody === -1) {
    setImmediate(localSessionDetailReturnFull, req, res, session, outgoing);
  }
}

function imageDecode(req, res, session, results, findBody) {
  if ((results[0].data.length >= 4 && results[0].data.slice(0,4).toString() === "HTTP") ||
      (results[1] && results[1].data.length >= 4 && results[1].data.slice(0,4).toString() === "HTTP")) {
    return imageDecodeHTTP(req, res, session, results, findBody);
  }

  if ((results[0].data.length >= 4 && results[0].data.slice(0,4).toString().match(/(HELO|EHLO)/)) ||
      (results[1] && results[1].data.length >= 4 && results[1].data.slice(0,4).toString().match(/(HELO|EHLO)/)) ||
      (results[2] && results[1].data.length >= 4 && results[2].data.slice(0,4).toString().match(/(HELO|EHLO)/))) {
    return imageDecodeSMTP(req, res, session, results, findBody);
  }

  req.query.needimage = "false";
  if (findBody === -1) {
    setImmediate(localSessionDetailReturn, req, res, session, results);
  }
}

function localSessionDetailReturn(req, res, session, incoming) {
  if (incoming.length > 200) {
    incoming.length = 200;
  }

  if (req.query.needgzip === "true" && incoming.length > 0) {
    return gzipDecode(req, res, session, incoming);
  }

  if (req.query.needimage === "true" && incoming.length > 0) {
    return imageDecode(req, res, session, incoming, -1);
  }

  var outgoing = [];
  for (var r = 0, rlen = incoming.length; r < rlen; r++) {
    outgoing.push({pieces: [{raw: incoming[r].data}], ts: incoming[r].ts});
  }
  localSessionDetailReturnFull(req, res, session, outgoing);
}


function localSessionDetail(req, res) {
  if (!req.query) {
    req.query = {gzip: false, line: false, base: "natural"};
  }

  req.query.needgzip  = req.query.gzip  || false;
  req.query.needimage = req.query.image || false;
  req.query.line  = req.query.line  || false;
  req.query.base  = req.query.base  || "ascii";

  var packets = [];
  processSessionId(req.params.id, true, null, function (pcap, buffer, cb, i) {
    var obj = {};
    if (buffer.length > 16) {
      try {
        pcap.decode(buffer, obj);
      } catch (e) {
        obj = {ip: {p: "Error decoding" + e}};
        console.trace("loadSessionDetail error", e);
      }
    } else {
      obj = {ip: {p: "Empty"}};
    }
    packets[i] = obj;
    cb(null);
  },
  function(err, session) {
    if (err && session === null) {
      return res.send("Couldn't look up SPI data, error for session " + req.params.id + " Error: " +  err);
    }
    session.id = req.params.id;
    session.ta = session.ta.sort();
    if (session.hh) {
      session.hh = session.hh.sort();
    }
    if (session.hh1) {
      session.hh1 = session.hh1.sort();
    }
    if (session.hh2) {
      session.hh2 = session.hh2.sort();
    }
    if (session.pr) {
      session.pr = Pcap.protocol2Name(session.pr);
    }
    //console.log("session", util.inspect(session, false, 15));
    /* Now reassembly the packets */
    if (packets.length === 0) {
      session._err = err || "No pcap data found";
      localSessionDetailReturn(req, res, session, []);
    } else if (packets[0].ip === undefined) {
      session._err = "Couldn't decode pcap file, check viewer log";
      localSessionDetailReturn(req, res, session, []);
    } else if (packets[0].ip.p === 1) {
      Pcap.reassemble_icmp(packets, function(err, results) {
        session._err = err;
        localSessionDetailReturn(req, res, session, results || []);
      });
    } else if (packets[0].ip.p === 6) {
      Pcap.reassemble_tcp(packets, Pcap.inet_ntoa(session.a1) + ':' + session.p1, function(err, results) {
        session._err = err;
        localSessionDetailReturn(req, res, session, results || []);
      });
    } else if (packets[0].ip.p === 17) {
      Pcap.reassemble_udp(packets, function(err, results) {
        session._err = err;
        localSessionDetailReturn(req, res, session, results || []);
      });
    } else {
      session._err = "Unknown ip.p=" + packets[0].ip.p;
      localSessionDetailReturn(req, res, session, []);
    }
  },
  req.query.needimage === "true"?10000:400, 10);
}

app.get('/:nodeName/:id/sessionDetail', function(req, res) {
  isLocalView(req.params.nodeName, function () {
    noCache(req, res);
    localSessionDetail(req, res);
  },
  function () {
    return proxyRequest(req, res, function (err) {
      Db.get(Db.id2Index(req.params.id), 'session', req.params.id, function(err, session) {
        var fields = session._source || session.fields;
        fields._err = "Couldn't connect to remote viewer, only displaying SPI data";
        localSessionDetailReturnFull(req, res, fields, []);
      });
    });
  });

});


app.get('/:nodeName/:id/body/:bodyType/:bodyNum/:bodyName', checkProxyRequest, function(req, res) {
  processSessionIdAndDecode(req.params.id, 10000, function(err, session, results) {
    if (err) {
      return res.send("Error");
    }
    if (req.params.bodyType === "file") {
      res.setHeader("Content-Type", "application/force-download");
    }
    return imageDecode(req, res, session, results, +req.params.bodyNum);
  });
});

app.get('/:nodeName/:id/bodypng/:bodyType/:bodyNum/:bodyName', checkProxyRequest, function(req, res) {
  if (!Png) {
    return res.send (internals.emptyPNG);
  }
  processSessionIdAndDecode(req.params.id, 10000, function(err, session, results) {
    if (err) {
      return res.send (internals.emptyPNG);
    }
    res.setHeader("Content-Type", "image/png");
    var newres = {
      finished: false,
      fullbuf: new Buffer(0),
      write: function(buf) {
        this.fullbuf = Buffer.concat([this.fullbuf, buf]);
      },
      end: function(buf) {
        this.finished = true;
        if (buf) {this.write(buf);}
        if (this.fullbuf.length === 0) {
          return res.send (internals.emptyPNG);
        }
        var png = new Png(this.fullbuf, internals.PNG_LINE_WIDTH, Math.ceil(this.fullbuf.length/internals.PNG_LINE_WIDTH), 'gray');
        var png_image = png.encodeSync();

        res.send(png_image);
      }
    };
    return imageDecode(req, newres, session, results, +req.params.bodyNum);
  });
});

function writePcap(res, id, options, doneCb) {
  var b = new Buffer(0xfffe);
  var nextPacket = 0;
  var boffset = 0;
  var packets = {};

  processSessionId(id, false, function (pcap, buffer) {
    if (options.writeHeader) {
      res.write(buffer);
      options.writeHeader = false;
    }
  },
  function (pcap, buffer, cb, i) {
    // Save this packet in its spot
    packets[i] = buffer;

    // Send any packets we have in order
    while (packets[nextPacket]) {
      buffer = packets[nextPacket];
      delete packets[nextPacket];
      nextPacket++;

      if (boffset + buffer.length > b.length) {
        res.write(b.slice(0, boffset));
        boffset = 0;
        b = new Buffer(0xfffe);
      }
      buffer.copy(b, boffset, 0, buffer.length);
      boffset += buffer.length;
    }
    cb(null);
  },
  function(err, session) {
    if (err) {
      console.log("writePcap", err);
    }
    res.write(b.slice(0, boffset));
    doneCb(err);
  }, undefined, 10);
}

function writePcapNg(res, id, options, doneCb) {
  var b = new Buffer(0xfffe);
  var boffset = 0;

  processSessionId(id, true, function (pcap, buffer) {
    if (options.writeHeader) {
      res.write(pcap.getHeaderNg());
      options.writeHeader = false;
    }
  },
  function (pcap, buffer, cb) {
    if (boffset + buffer.length + 20 > b.length) {
      res.write(b.slice(0, boffset));
      boffset = 0;
      b = new Buffer(0xfffe);
    }

    /* Need to write the ng block, and conver the old timestamp */

    b.writeUInt32LE(0x00000006, boffset);               // Block Type
    var len = ((buffer.length + 20 + 3) >> 2) << 2;
    b.writeUInt32LE(len, boffset + 4);                  // Block Len 1
    b.writeUInt32LE(0, boffset + 8);                    // Interface Id

    // js has 53 bit numbers, this will over flow on Jun 05 2255
    var time = buffer.readUInt32LE(0)*1000000 + buffer.readUInt32LE(4);
    b.writeUInt32LE(Math.floor(time / 0x100000000), boffset + 12);         // Block Len 1
    b.writeUInt32LE(time % 0x100000000, boffset + 16);   // Interface Id

    buffer.copy(b, boffset + 20, 8, buffer.length - 8);     // cap_len, packet_len
    b.fill(0, boffset + 12 + buffer.length, boffset + 12 + buffer.length + (4 - (buffer.length%4)) % 4);   // padding
    boffset += len - 8;

    b.writeUInt32LE(0, boffset);                        // Options
    b.writeUInt32LE(len, boffset+4);                    // Block Len 2
    boffset += 8;

    cb(null);
  },
  function(err, session) {
    if (err) {
      console.log("writePcapNg", err);
      return;
    }
    res.write(b.slice(0, boffset));

    session.version = molochversion.version;
    delete session.ps;
    var json = JSON.stringify(session);

    var len = ((json.length + 20 + 3) >> 2) << 2;
    b = new Buffer(len);

    b.writeUInt32LE(0x80808080, 0);               // Block Type
    b.writeUInt32LE(len, 4);                      // Block Len 1
    b.write("MOWL", 8);                           // Magic
    b.writeUInt32LE(json.length, 12);             // Block Len 1
    b.write(json, 16);                            // Magic
    b.fill(0, 16 + json.length, 16 + json.length + (4 - (json.length%4)) % 4);   // padding
    b.writeUInt32LE(len, len-4);                  // Block Len 2
    res.write(b);

    doneCb(err);
  });
}

app.get('/:nodeName/pcapng/:id.pcapng', checkProxyRequest, function(req, res) {
  noCache(req, res, "application/vnd.tcpdump.pcap");
  writePcapNg(res, req.params.id, {writeHeader: !req.query || !req.query.noHeader || req.query.noHeader !== "true"}, function () {
    res.end();
  });
});

app.get('/:nodeName/pcap/:id.pcap', checkProxyRequest, function(req, res) {
  noCache(req, res, "application/vnd.tcpdump.pcap");

  writePcap(res, req.params.id, {writeHeader: !req.query || !req.query.noHeader || req.query.noHeader !== "true"}, function () {
    res.end();
  });
});

app.get('/:nodeName/raw/:id.png', checkProxyRequest, function(req, res) {
  noCache(req, res, "image/png");

  if (!Png) {
    return res.send (internals.emptyPNG);
  }

  processSessionIdAndDecode(req.params.id, 100, function(err, session, results) {
    if (err) {
      return res.send (internals.emptyPNG);
    }
    var size = 0;
    var i, ilen;
    for (i = (req.query.type !== 'dst'?0:1), ilen = results.length; i < ilen; i+=2) {
      size += results[i].data.length + 2*internals.PNG_LINE_WIDTH - (results[i].data.length % internals.PNG_LINE_WIDTH);
    }
    var buffer = new Buffer(size);
    var pos = 0;
    if (size === 0) {
      return res.send (internals.emptyPNG);
    }
    for (i = (req.query.type !== 'dst'?0:1), ilen = results.length; i < ilen; i+=2) {
      results[i].data.copy(buffer, pos);
      pos += results[i].data.length;
      var fillpos = pos;
      pos += 2*internals.PNG_LINE_WIDTH - (results[i].data.length % internals.PNG_LINE_WIDTH);
      buffer.fill(0xff, fillpos, pos);
    }

    var png = new Png(buffer, internals.PNG_LINE_WIDTH, (size/internals.PNG_LINE_WIDTH)-1, 'gray');
    var png_image = png.encodeSync();

    res.send(png_image);
  });
});

app.get('/:nodeName/raw/:id', checkProxyRequest, function(req, res) {
  noCache(req, res, "application/vnd.tcpdump.pcap");

  processSessionIdAndDecode(req.params.id, 10000, function(err, session, results) {
    if (err) {
      return res.send("Error");
    }
    for (var i = (req.query.type !== 'dst'?0:1), ilen = results.length; i < ilen; i+=2) {
      res.write(results[i].data);
    }
    res.end();
  });
});

app.get('/:nodeName/entirePcap/:id.pcap', checkProxyRequest, function(req, res) {
  noCache(req, res, "application/vnd.tcpdump.pcap");

  var options = {writeHeader: true};

  var query = { _source: ["ro"],
                size: 1000,
                query: {term: {ro: req.params.id}},
                sort: { lp: { order: 'asc' } }
              };

  console.log("entirePcap query", JSON.stringify(query));

  Db.searchPrimary('sessions-*', 'session', query, function(err, data) {
    async.forEachSeries(data.hits.hits, function(item, nextCb) {
      writePcap(res, item._id, options, nextCb);
    }, function (err) {
      res.end();
    });
  });
});

function sessionsPcapList(req, res, list, pcapWriter, extension) {

  if (list.length > 0 && list[0].fields) {
    list = list.sort(function(a,b){return a.fields.lp - b.fields.lp;});
  } else if (list.length > 0 && list[0]._source) {
    list = list.sort(function(a,b){return a._source.lp - b._source.lp;});
  }

  var options = {writeHeader: true};

  async.eachLimit(list, 10, function(item, nextCb) {
    var fields = item._source || item.fields;
    isLocalView(fields.no, function () {
      // Get from our DISK
      pcapWriter(res, item._id, options, nextCb);
    },
    function () {
      // Get from remote DISK
      getViewUrl(fields.no, function(err, viewUrl, client) {
        var buffer = new Buffer(fields.pa*20 + fields.by);
        var bufpos = 0;
        var info = url.parse(viewUrl);
        info.path = Config.basePath(fields.no) + fields.no + "/" + extension + "/" + item._id + "." + extension;
        info.agent = (client === http?internals.httpAgent:internals.httpsAgent);

        addAuth(info, req.user, fields.no);
        addCaTrust(info, fields.no);
        var preq = client.request(info, function(pres) {
          pres.on('data', function (chunk) {
            if (bufpos + chunk.length > buffer.length) {
              var tmp = new Buffer(buffer.length + chunk.length*10);
              buffer.copy(tmp, 0, 0, bufpos);
              buffer = tmp;
            }
            chunk.copy(buffer, bufpos);
            bufpos += chunk.length;
          });
          pres.on('end', function () {
            if (bufpos < 24) {
            } else if (options.writeHeader) {
              options.writeHeader = false;
              res.write(buffer.slice(0, bufpos));
            } else {
              res.write(buffer.slice(24, bufpos));
            }
            setImmediate(nextCb);
          });
        });
        preq.on('error', function (e) {
          console.log("ERROR - Couldn't proxy pcap request=", info, "\nerror=", e);
          nextCb(null);
        });
        preq.end();
      });
    });
  }, function(err) {
    res.end();
  });
}

function sessionsPcap(req, res, pcapWriter, extension) {
  noCache(req, res, "application/vnd.tcpdump.pcap");

  if (req.query.ids) {
    var ids = req.query.ids.split(",");

    sessionsListFromIds(req, ids, ["lp", "no", "by", "pa", "ro"], function(err, list) {
      sessionsPcapList(req, res, list, pcapWriter, extension);
    });
  } else {
    sessionsListFromQuery(req, res, ["lp", "no", "by", "pa", "ro"], function(err, list) {
      sessionsPcapList(req, res, list, pcapWriter, extension);
    });
  }
}

app.get(/\/sessions.pcapng.*/, function(req, res) {
  return sessionsPcap(req, res, writePcapNg, "pcapng");
});

app.get(/\/sessions.pcap.*/, function(req, res) {
  return sessionsPcap(req, res, writePcap, "pcap");
});


app.post('/deleteUser/:userId', checkToken, function(req, res) {
  if (!req.user.createEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need admin privileges"}));
  }

  if (req.params.userId === req.user.userId) {
    return res.send(JSON.stringify({success: false, text: "Can not delete yourself"}));
  }

  Db.deleteUser(req.params.userId, function(err, data) {
    setTimeout(function (){res.send(JSON.stringify({success: true, text: "User deleted"}));}, 200);
  });
});

app.post('/addUser', checkToken, function(req, res) {
  if (!req.user.createEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need admin privileges"}));
  }

  if (!req.body || !req.body.userId || !req.body.userName || !req.body.password) {
    return res.send(JSON.stringify({success: false, text: "Missing/Empty required fields"}));
  }

  if (req.body.userId.match(/[^\w.-]/)) {
    return res.send(JSON.stringify({success: false, text: "User id must be word characters"}));
  }

  Db.getUser(req.body.userId, function(err, user) {
    if (!user || user.found) {
      console.log("Adding duplicate user", err, user);
      return res.send(JSON.stringify({success: false, text: "User already exists"}));
    }

    var nuser = {
      userId: req.body.userId,
      userName: req.body.userName,
      expression: req.body.expression,
      passStore: Config.pass2store(req.body.userId, req.body.password),
      enabled: req.body.enabled  === "on",
      webEnabled: req.body.webEnabled  === "on",
      emailSearch: req.body.emailSearch  === "on",
      headerAuthEnabled: req.body.headerAuthEnabled === "on",
      createEnabled: req.body.createEnabled === "on",
      removeEnabled: req.body.removeEnabled === "on"
    };

    console.log("Creating new user", nuser);
    Db.setUser(req.body.userId, nuser, function(err, info) {
      if (!err) {
        return res.send(JSON.stringify({success: true}));
      } else {
        console.log("ERROR - add user", err, info);
        return res.send(JSON.stringify({success: false, text: err}));
      }
    });
  });
});

app.post('/updateUser/:userId', checkToken, function(req, res) {
  if (!req.user.createEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need admin privileges"}));
  }

  Db.getUser(req.params.userId, function(err, user) {
    if (err || !user.found) {
      console.log("update user failed", err, user);
      return res.send(JSON.stringify({success: false, text: "User not found"}));
    }
    user = user._source;

    if (req.query.enabled !== undefined) {
      user.enabled = req.query.enabled === "true";
    }

    if (req.query.expression !== undefined) {
      if (req.query.expression.match(/^\s*$/)) {
        delete user.expression;
      } else {
        user.expression = req.query.expression;
      }
    }

    if (req.query.userName !== undefined) {
      if (req.query.userName.match(/^\s*$/)) {
        console.log("ERROR - empty username", req.query);
        return res.send(JSON.stringify({success: false, text: "Username can not be empty"}));
      } else {
        user.userName = req.query.userName;
      }
    }

    if (req.query.webEnabled !== undefined) {
      user.webEnabled = req.query.webEnabled === "true";
    }

    if (req.query.emailSearch !== undefined) {
      user.emailSearch = req.query.emailSearch === "true";
    }

    if (req.query.headerAuthEnabled !== undefined) {
      user.headerAuthEnabled = req.query.headerAuthEnabled === "true";
    }

    if (req.query.removeEnabled !== undefined) {
      user.removeEnabled = req.query.removeEnabled === "true";
    }

    // Can only change createEnabled if it is currently turned on
    if (req.query.createEnabled !== undefined && req.user.createEnabled && req.query.createEnabled) {
      user.createEnabled = req.query.createEnabled === "true";
    }

    Db.setUser(req.params.userId, user, function(err, info) {
      return res.send(JSON.stringify({success: true}));
    });
  });
});

app.post('/changePassword', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  if (Config.get("disableChangePassword", false)) {
    return error("Disabled");
  }

  if (!req.body.newPassword || req.body.newPassword.length < 3) {
    return error("New password needs to be at least 3 characters");
  }

  if (req.token.cp && (req.user.passStore !== Config.pass2store(req.token.suserId, req.body.currentPassword) ||
                   req.token.suserId !== req.user.userId)) {
    return error("Current password mismatch");
  }

  Db.getUser(req.token.suserId, function(err, user) {
    if (err || !user.found) {
      console.log("changePassword failed", err, user);
      return error("Unknown user");
    }
    user = user._source;
    user.passStore = Config.pass2store(user.userId, req.body.newPassword);
    Db.setUser(user.userId, user, function(err, info) {
      if (err) {
        console.log("changePassword error", err, info);
        return error("Update failed");
      }
      return res.send(JSON.stringify({success: true, text: "Changed password successfully"}));
    });
  });
});

app.post('/changeSettings', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  Db.getUser(req.token.suserId, function(err, user) {
    if (err || !user.found) {
      console.log("changeSettings failed", err, user);
      return error("Unknown user");
    }

    user = user._source;
    user.settings = req.body;
    delete user.settings.token;

    Db.setUser(user.userId, user, function(err, info) {
      if (err) {
        console.log("changeSettings error", err, info);
        return error("Change settings update failed");
      }
      return res.send(JSON.stringify({success: true, text: "Changed password successfully"}));
    });
  });
});

app.post('/updateView', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  if (!req.body.viewName || !req.body.viewExpression) {
    return error("Missing viewName or viewExpression");
  }

  Db.getUser(req.token.suserId, function(err, user) {
    if (err || !user.found) {
      console.log("updateView failed", err, user);
      return error("Unknown user");
    }

    user = user._source;
    user.views = user.views || {};
    var container = user.views;
    if (req.body.groupName) {
      req.body.groupName = req.body.groupName.replace(/[^-a-zA-Z0-9_: ]/g, "");
      if (!user.views._groups) {
        user.views._groups = {};
      }
      if (!user.views._groups[req.body.groupName]) {
        user.views._groups[req.body.groupName] = {};
      }
      container = user.views._groups[req.body.groupName];
    }
    req.body.viewName = req.body.viewName.replace(/[^-a-zA-Z0-9_: ]/g, "");
    if (container[req.body.viewName]) {
      container[req.body.viewName].expression = req.body.viewExpression;
    } else {
      container[req.body.viewName] = {expression: req.body.viewExpression};
    }

    Db.setUser(user.userId, user, function(err, info) {
      if (err) {
        console.log("updateView error", err, info);
        return error("Create View update failed");
      }
      return res.send(JSON.stringify({success: true, text: "Updated view successfully"}));
    });
  });
});

app.post('/deleteView', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  if (!req.body.view) {
    return error("Missing view");
  }

  Db.getUser(req.token.suserId, function(err, user) {
    if (err || !user.found) {
      console.log("updateView failed", err, user);
      return error("Unknown user");
    }

    user = user._source;
    user.views = user.views || {};
    delete user.views[req.body.view];

    Db.setUser(user.userId, user, function(err, info) {
      if (err) {
        console.log("deleteView error", err, info);
        return error("Create View update failed");
      }
      return res.send(JSON.stringify({success: true, text: "Deleted view successfully"}));
    });
  });
});

app.post('/cronQueries.json', checkToken, function(req, res) {
  var results = [];
  Db.search("queries", "query", {size:1000, query: {term: {creator: req.user.userId}}}, function (err, data) {
    if (err || !data.hits || !data.hits.hits) {
      return res.send(JSON.stringify(results));
    }

    for (var i = 0, ilen = data.hits.hits.length; i < ilen; i++) {
      results.push(data.hits.hits[i]._source);
    }

    res.send(JSON.stringify(results));
  });
});

app.post('/updateCronQuery', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  if (!req.body.key || !req.body.name || req.body.query === undefined || !req.body.action) {
    return error("Missing required parameter");
  }

  var document = {
    doc: {
      enabled: (req.body.enabled === "true"),
      name:req.body.name,
      query: req.body.query,
      tags: req.body.tags,
      action: req.body.action
    }
  };

  if (req.body.key === "_create_") {
    if (req.body.since === "-1") {
      document.doc.lpValue =  document.doc.lastRun = 0;
    } else {
      document.doc.lpValue =  document.doc.lastRun = Math.floor(Date.now()/1000) - 60*60*parseInt(req.body.since || "0", 10);
    }
    document.doc.count = 0;
    document.doc.creator = req.user.userId || "anonymous";
    Db.indexNow("queries", "query", null, document.doc, function(err, info) {
      if (Config.get("cronQueries", false)) {
        processCronQueries();
      }
      return res.send(JSON.stringify({success: true, text: "Created", key: info._id}));
    });
    return;
  }

  Db.get("queries", 'query', req.body.key, function(err, sq) {
    if (err || !sq.found) {
      console.log("updateCronQuery failed", err, sq);
      return error("Unknown query");
    }

    Db.update('queries', 'query', req.body.key, document, {refresh: 1}, function(err, data) {
      if (err) {
        console.log("updateCronQuery error", err, document, data);
        return error("Cron query update failed");
      }
      if (Config.get("cronQueries", false)) {
        processCronQueries();
      }
      return res.send(JSON.stringify({success: true, text: "Updated cron query successfully"}));
    });
  });
});

app.post('/deleteCronQuery', checkToken, function(req, res) {
  function error(text) {
    return res.send(JSON.stringify({success: false, text: text}));
  }

  if (!req.body.key) {
    return error("Missing cron query key");
  }

  Db.deleteDocument("queries", 'query', req.body.key, {refresh: 1}, function(err, sq) {
    res.send(JSON.stringify({success: true, text: "Deleted view successfully"}));
  });
});

//////////////////////////////////////////////////////////////////////////////////
//// Session Add/Remove Tags
//////////////////////////////////////////////////////////////////////////////////

function addTagsList(allTagIds, list, doneCb) {
  async.eachLimit(list, 10, function(session, nextCb) {
    var tagIds = [];

    var fields = session._source || session.fields;

    if (!fields || !fields.ta) {
      console.log("NO TA", session);
      return nextCb(null);
    }

    // Find which tags need to be added to this session
    for (var i = 0, ilen = allTagIds.length; i < ilen; i++) {
      if (fields.ta.indexOf(allTagIds[i]) === -1) {
        fields.ta.push(allTagIds[i]);
      }
    }

    // Do the ES update
    var document = {
      doc: {
        ta: fields.ta
      }
    };
    Db.update(Db.id2Index(session._id), 'session', session._id, document, function(err, data) {
      if (err) {
        console.log("CAN'T UPDATE", session, err, data);
      }
      nextCb(null);
    });
  }, doneCb);
}

function removeTagsList(res, allTagIds, list) {
  async.eachLimit(list, 10, function(session, nextCb) {
    var tagIds = [];

    var fields = session._source || session.fields;
    if (!fields || !fields.ta) {
      return nextCb(null);
    }

    // Find which tags need to be removed from this session
    for (var i = 0, ilen = allTagIds.length; i < ilen; i++) {
      var pos = fields.ta.indexOf(allTagIds[i]);
      if (pos !== -1) {
        fields.ta.splice(pos, 1);
      }
    }

    // Do the ES update
    var document = {
      doc: {
        ta: fields.ta
      }
    };
    Db.update(Db.id2Index(session._id), 'session', session._id, document, function(err, data) {
      if (err) {
        console.log("removeTagsList error", err);
      }
      nextCb(null);
    });
  }, function (err) {
    return res.send(JSON.stringify({success: true, text: "Tags removed successfully"}));
  });
}

function mapTags(tags, prefix, tagsCb) {
  async.map(tags, function (tag, cb) {
    Db.tagNameToId(prefix + tag, function (tagid) {
      if (tagid === -1) {
        Db.createTag(prefix + tag, function(tagid) {
          cb(null, tagid);
        });
      } else {
        cb(null, tagid);
      }
    });
  }, function (err, result) {
    tagsCb(null, result);
  });
}

app.post('/addTags', function(req, res) {
  var tags = [];
  if (req.body.tags) {
    tags = req.body.tags.replace(/[^-a-zA-Z0-9_:,]/g, "").split(",");
  }

  if (tags.length === 0) {
    return res.send(JSON.stringify({success: false, text: "No tags specified"}));
  }

  mapTags(tags, "", function(err, tagIds) {
    if (req.body.ids) {
      var ids = req.body.ids.split(",");

      sessionsListFromIds(req, ids, ["ta"], function(err, list) {
        addTagsList(tagIds, list, function () {
          return res.send(JSON.stringify({success: true, text: "Tags added successfully"}));
        });
      });
    } else {
      sessionsListFromQuery(req, res, ["ta"], function(err, list) {
        addTagsList(tagIds, list, function () {
          return res.send(JSON.stringify({success: true, text: "Tags added successfully"}));
        });
      });
    }
  });
});

app.post('/removeTags', function(req, res) {
  if (!req.user.removeEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need remove data privileges"}));
  }
  var tags = [];
  if (req.body.tags) {
    tags = req.body.tags.replace(/[^-a-zA-Z0-9_:,]/g, "").split(",");
  }

  if (tags.length === 0) {
    return res.send(JSON.stringify({success: false, text: "No tags specified"}));
  }

  mapTags(tags, "", function(err, tagIds) {
    if (req.body.ids) {
      var ids = req.body.ids.split(",");

      sessionsListFromIds(req, ids, ["ta"], function(err, list) {
        removeTagsList(res, tagIds, list);
      });
    } else {
      sessionsListFromQuery(req, res, ["ta"], function(err, list) {
        removeTagsList(res, tagIds, list);
      });
    }
  });
});

//////////////////////////////////////////////////////////////////////////////////
//// Pcap Delete/Scrub
//////////////////////////////////////////////////////////////////////////////////

function pcapScrub(req, res, id, entire, endCb) {
  if (pcapScrub.scrubbingBuffers === undefined) {
    pcapScrub.scrubbingBuffers = [new Buffer(5000), new Buffer(5000), new Buffer(5000)];
    pcapScrub.scrubbingBuffers[0].fill(0);
    pcapScrub.scrubbingBuffers[1].fill(1);
    var str = "Scrubbed! Hoot! ";
    for (var i = 0; i < 5000;) {
      i += pcapScrub.scrubbingBuffers[2].write(str, i);
    }
  }

  function processFile(pcap, pos, i, nextCb) {
    pcap.ref();
    pcap.readPacket(pos, function(packet) {
      pcap.unref();

      if (packet) {
        if (packet.length > 16) {
          try {
            var obj = {};
            pcap.decode(packet, obj);
            pcap.scrubPacket(obj, pos, pcapScrub.scrubbingBuffers[0], entire);
            pcap.scrubPacket(obj, pos, pcapScrub.scrubbingBuffers[1], entire);
            pcap.scrubPacket(obj, pos, pcapScrub.scrubbingBuffers[2], entire);
          } catch (e) {
            console.log("Couldn't scrub packet at ", pos, e);
          }
          return nextCb(null);
        } else {
          console.log("Couldn't scrub packet at ", pos);
          return nextCb(null);
        }
      }
    });
  }

  Db.getWithOptions(Db.id2Index(id), 'session', id, {fields: "no,pr,ps,psl"}, function(err, session) {
    var fields = session._source || session.fields;

    var fileNum;
    var itemPos = 0;
    async.eachLimit(fields.ps, 10, function(pos, nextCb) {
      if (pos < 0) {
        fileNum = pos * -1;
        return nextCb(null);
      }

      // Get the pcap file for this node a filenum, if it isn't opened then do the filename lookup and open it
      var opcap = Pcap.get("write"+fields.no + ":" + fileNum);
      if (!opcap.isOpen()) {
        Db.fileIdToFile(fields.no, fileNum, function(file) {

          if (!file) {
            console.log("WARNING - Only have SPI data, PCAP file no longer available", fields.no + '-' + fileNum);
            return nextCb("Only have SPI data, PCAP file no longer available for " + fields.no + '-' + fileNum);
          }

          var ipcap = Pcap.get("write"+fields.no + ":" + file.num);

          try {
            ipcap.openReadWrite(file.name);
          } catch (err) {
            console.log("ERROR - Couldn't open file for writing", err);
            return nextCb("Couldn't open file for writing " + err);
          }

          processFile(ipcap, pos, itemPos++, nextCb);
        });
      } else {
        processFile(opcap, pos, itemPos++, nextCb);
      }
    },
    function (pcapErr, results) {
      if (entire) {
        Db.deleteDocument(Db.id2Index(session._id), 'session', session._id, function(err, data) {
          endCb(pcapErr, fields);
        });
      } else {
        // Do the ES update
        var document = {
          doc: {
            scrubby: req.user.userId || "-",
            scrubat: new Date().getTime()
          }
        };
        Db.update(Db.id2Index(session._id), 'session', session._id, document, function(err, data) {
          endCb(pcapErr, fields);
        });
      }
    });
  });
}

app.get('/:nodeName/scrub/:id', checkProxyRequest, function(req, res) {
  if (!req.user.removeEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need remove data privileges"}));
  }

  noCache(req, res);
  res.statusCode = 200;

  pcapScrub(req, res, req.params.id, false, function(err) {
    res.end();
  });
});

app.get('/:nodeName/delete/:id', checkProxyRequest, function(req, res) {
  if (!req.user.removeEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need remove data privileges"}));
  }

  noCache(req, res);
  res.statusCode = 200;

  pcapScrub(req, res, req.params.id, true, function(err) {
    res.end();
  });
});


function scrubList(req, res, entire, list) {
  if (!list) {
    return res.end(JSON.stringify({success: false, text: "Missing list of sessions"}));
  }

  async.eachLimit(list, 10, function(item, nextCb) {
    var fields = item._source || item.fields;

    isLocalView(fields.no, function () {
      // Get from our DISK
      pcapScrub(req, res, item._id, entire, nextCb);
    },
    function () {
      // Get from remote DISK
      getViewUrl(fields.no, function(err, viewUrl, client) {
        var info = url.parse(viewUrl);
        info.path = Config.basePath(fields.no) + fields.no + (entire?"/delete/":"/scrub/") + item._id;
        info.agent = (client === http?internals.httpAgent:internals.httpsAgent);
        addAuth(info, req.user, fields.no);
        addCaTrust(info, fields.no);
        var preq = client.request(info, function(pres) {
          pres.on('end', function () {
            setImmediate(nextCb);
          });
        });
        preq.on('error', function (e) {
          console.log("ERROR - Couldn't proxy scrub request=", info, "\nerror=", e);
          nextCb(null);
        });
        preq.end();
      });
    });
  }, function(err) {
    return res.end(JSON.stringify({success: true, text: (entire?"Deleting of ":"Scrubbing of ") + list.length + " sessions complete"}));
  });
}

app.post('/scrub', function(req, res) {
  if (!req.user.removeEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need remove data privileges"}));
  }

  if (req.body.ids) {
    var ids = req.body.ids.split(",");

    sessionsListFromIds(req, ids, ["no"], function(err, list) {
      scrubList(req, res, false, list);
    });
  } else if (req.query.expression) {
    sessionsListFromQuery(req, res, ["no"], function(err, list) {
      scrubList(req, res, false, list);
    });
  } else {
    res.end("Missing expression or list of ids");
  }
});

app.post('/delete', function(req, res) {
  if (!req.user.removeEnabled) {
    return res.send(JSON.stringify({success: false, text: "Need remove data privileges"}));
  }

  if (req.body.ids) {
    var ids = req.body.ids.split(",");

    sessionsListFromIds(req, ids, ["no"], function(err, list) {
      scrubList(req, res, true, list);
    });
  } else if (req.query.expression) {
    sessionsListFromQuery(req, res, ["no"], function(err, list) {
      scrubList(req, res, true, list);
    });
  } else {
    res.end("Missing expression or list of ids");
  }
});

//////////////////////////////////////////////////////////////////////////////////
//// Sending/Receive sessions
//////////////////////////////////////////////////////////////////////////////////
function sendSessionWorker(options, cb) {
  var packetslen = 0;
  var packets = [];
  var packetshdr;
  var ps = [-1];
  var tags = [];

  if (!options.saveId) {
    return cb({success: false, text: "Missing saveId"});
  }

  if (!options.cluster) {
    return cb({success: false, text: "Missing cluster"});
  }

  processSessionId(options.id, true, function(pcap, header) {
    packetshdr = header;
  }, function (pcap, packet, pcb, i) {
    packetslen += packet.length;
    packets[i] = packet;
    pcb(null);
  }, function (err, session) {
    var buffer;
    if (err || !packetshdr) {
      console.log("WARNING - No PCAP only sending SPI data err:", err);
      buffer = new Buffer(0);
      ps = [];
    } else {
      buffer = new Buffer(packetshdr.length + packetslen);
      var pos = 0;
      packetshdr.copy(buffer);
      pos += packetshdr.length;
      for(var i = 0, ilen = packets.length; i < ilen; i++) {
        ps.push(pos);
        packets[i].copy(buffer, pos);
        pos += packets[i].length;
      }
    }
    if (!session) {
      console.log("no session" , session, "err", err, "id", options.id);
      return;
    }
    session.id = options.id;
    session.ps = ps;
    delete session.fs;

    if (options.tags) {
      tags = options.tags.replace(/[^-a-zA-Z0-9_:,]/g, "").split(",");
      if (!session.ta) {
        session.ta = [];
      }
      session.ta = session.ta.concat(tags);
    }

    var molochClusters = Config.configMap("moloch-clusters");
    if (!molochClusters) {
      console.log("ERROR - sendSession is not configured");
      return cb();
    }

    var sobj = molochClusters[options.cluster];
    if (!sobj) {
      console.log("ERROR - moloch-clusters is not configured for " + options.cluster);
      return cb();
    }

    var info = url.parse(sobj.url + "/receiveSession?saveId=" + options.saveId);
    addAuth(info, options.user, options.nodeName, sobj.passwordSecret);
    info.method = "POST";

    var result = "";
    var client = info.protocol === "https:"?https:http;
    info.agent = (client === http?internals.httpAgent:internals.httpsAgent);
    addCaTrust(info, options.nodeName);
    var preq = client.request(info, function(pres) {
      pres.on('data', function (chunk) {
        result += chunk;
      });
      pres.on('end', function () {
        result = JSON.parse(result);
        if (!result.success) {
          console.log("ERROR sending session ", result);
        }
        cb();
      });
    });

    preq.on('error', function (e) {
      console.log("ERROR - Couldn't connect to ", info, "\nerror=", e);
      cb();
    });

    var sessionStr = JSON.stringify(session);
    var b = new Buffer(12);
    b.writeUInt32BE(Buffer.byteLength(sessionStr), 0);
    b.writeUInt32BE(buffer.length, 8);
    preq.write(b);
    preq.write(sessionStr);
    preq.write(buffer);
    preq.end();
  }, undefined, 10);
}

internals.sendSessionQueue = async.queue(sendSessionWorker, 10);

app.get('/:nodeName/sendSession/:id', checkProxyRequest, function(req, res) {
  noCache(req, res);
  res.statusCode = 200;

  var options = {
    user: req.user,
    cluster: req.query.cluster,
    id: req.params.id,
    saveId: req.query.saveId,
    tags: req.query.tags,
    nodeName: req.params.nodeName
  };

  internals.sendSessionQueue.push(options, res.end);
});

app.post('/:nodeName/sendSessions', checkProxyRequest, function(req, res) {
  noCache(req, res);
  res.statusCode = 200;

  if (req.body.ids === undefined ||
      req.query.cluster === undefined ||
      req.query.saveId === undefined ||
      req.query.tags === undefined) {
    return res.end();
  }

  var count = 0;
  var ids = req.body.ids.split(",");
  ids.forEach(function(id) {
    var options = {
      user: req.user,
      cluster: req.query.cluster,
      id: id,
      saveId: req.query.saveId,
      tags: req.query.tags,
      nodeName: req.params.nodeName
    };

    count++;
    internals.sendSessionQueue.push(options, function () {
      count--;
      if (count === 0) {
        return res.end();
      }
    });
  });
});


function sendSessionsList(req, res, list) {
  if (!list) {
    return res.end(JSON.stringify({success: false, text: "Missing list of sessions"}));
  }

  var saveId = Config.nodeName() + "-" + new Date().getTime().toString(36);

  async.eachLimit(list, 10, function(item, nextCb) {
    var fields = item._source || item.fields;
    isLocalView(fields.no, function () {
      var options = {
        user: req.user,
        cluster: req.body.cluster,
        id: item._id,
        saveId: saveId,
        tags: req.query.tags,
        nodeName: fields.no
      };
      // Get from our DISK
      internals.sendSessionQueue.push(options, nextCb);
    },
    function () {
      // Get from remote DISK
      getViewUrl(fields.no, function(err, viewUrl, client) {
        var info = url.parse(viewUrl);
        info.path = Config.basePath(fields.no) + fields.no + "/sendSession/" + item._id + "?saveId=" + saveId + "&cluster=" + req.body.cluster;
        info.agent = (client === http?internals.httpAgent:internals.httpsAgent);
        if (req.query.tags) {
          info.path += "&tags=" + req.query.tags;
        }
        addAuth(info, req.user, fields.no);
        addCaTrust(info, fields.no);
        var preq = client.request(info, function(pres) {
          pres.on('data', function (chunk) {
          });
          pres.on('end', function () {
            setImmediate(nextCb);
          });
        });
        preq.on('error', function (e) {
          console.log("ERROR - Couldn't proxy sendSession request=", info, "\nerror=", e);
          nextCb(null);
        });
        preq.end();
      });
    });
  }, function(err) {
    return res.end(JSON.stringify({success: true, text: "Sending of " + list.length + " sessions complete"}));
  });
}

var qlworking = {};
function sendSessionsListQL(pOptions, list, nextQLCb) {
  if (!list) {
    return;
  }

  var nodes = {};

  list.forEach(function (item) {
    if (!nodes[item.no]) {
      nodes[item.no] = [];
    }
    nodes[item.no].push(item.id);
  });

  var keys = Object.keys(nodes);

  var count = 0;
  async.eachLimit(keys, 15, function(node, nextCb) {
    isLocalView(node, function () {
      var sent = 0;
      nodes[node].forEach(function(item) {
        var options = {
          id: item,
          nodeName: node
        };
        Db.merge(options, pOptions);

        // Get from our DISK
        internals.sendSessionQueue.push(options, function () {
          sent++;
          if (sent === nodes[node].length) {
            nextCb();
          }
        });
      });
    },
    function () {
      // Get from remote DISK
      getViewUrl(node, function(err, viewUrl, client) {
        var info = url.parse(viewUrl);
        info.method = "POST";
        info.path = Config.basePath(node) + node + "/sendSessions?saveId=" + pOptions.saveId + "&cluster=" + pOptions.cluster;
        info.agent = (client === http?internals.httpAgent:internals.httpsAgent);
        if (pOptions.tags) {
          info.path += "&tags=" + pOptions.tags;
        }
        addAuth(info, pOptions.user, node);
        addCaTrust(info, node);
        var preq = client.request(info, function(pres) {
          pres.on('data', function (chunk) {
            qlworking[info.path] = "data";
          });
          pres.on('end', function () {
            delete qlworking[info.path];
            count++;
            setImmediate(nextCb);
          });
        });
        preq.on('error', function (e) {
          delete qlworking[info.path];
          console.log("ERROR - Couldn't proxy sendSession request=", info, "\nerror=", e);
          setImmediate(nextCb);
        });
        preq.setHeader('content-type', "application/x-www-form-urlencoded");
        preq.write("ids=");
        preq.write(nodes[node].join(","));
        preq.end();
        qlworking[info.path] = "sent";
      });
    });
  }, function(err) {
    nextQLCb();
  });
}

app.post('/receiveSession', function receiveSession(req, res) {
  if (!req.query.saveId) {
    return res.send({success: false, text: "Missing saveId"});
  }

  // JS Static Variable :)
  receiveSession.saveIds = receiveSession.saveIds || {};

  var saveId = receiveSession.saveIds[req.query.saveId];
  if (!saveId) {
    saveId = receiveSession.saveIds[req.query.saveId] = {start: 0};
  }

  var sessionlen = -1;
  var filelen = -1;
  var written = 0;
  var session = null;
  var buffer;
  var file;
  var writeHeader;

  function makeFilename(cb) {
    if (saveId.filename) {
      return cb(saveId.filename);
    }

    // Just keep calling ourselves every 100 ms until we have a filename
    if (saveId.inProgress) {
      return setTimeout(makeFilename, 100, cb);
    }

    saveId.inProgress = 1;
    Db.getSequenceNumber("fn-" + Config.nodeName(), function (err, seq) {
      var filename = Config.get("pcapDir") + "/" + Config.nodeName() + "-" + seq + "-" + req.query.saveId + ".pcap";
      saveId.seq      = seq;
      Db.indexNow("files", "file", Config.nodeName() + "-" + saveId.seq, {num: saveId.seq, name: filename, first: session.fp, node: Config.nodeName(), filesize: -1, locked: 1}, function() {
        cb(filename);
        saveId.filename = filename; // Don't set the saveId.filename until after the first request completes its callback.
      });
    });
  }

  function saveSession() {
    function tags(container, field, prefix, cb) {
      if (!container[field]) {
        return cb(null);
      }

      mapTags(session[field], prefix, function (err, tagIds) {
        session[field] = tagIds;
        cb(null);
      });
    }

    async.parallel([
      function(parallelCb) {
        tags(session, "ta", "", parallelCb);
      },
      function(parallelCb) {
        tags(session, "hh1", "http:header:", parallelCb);
      },
      function(parallelCb) {
        tags(session, "hh2", "http:header:", parallelCb);
      }],
      function() {
        var id = session.id;
        delete session.id;
        Db.indexNow(Db.id2Index(id), "session", id, session, function(err, info) {
        });
      }
    );
  }

  function chunkWrite(chunk) {
    // Write full chunk if first packet and writeHeader or not first packet
    if (writeHeader || written !== 0) {
      writeHeader = false;
      file.write(chunk);
    } else {
      file.write(chunk.slice(24));
    }
    written += chunk.length; // Pretend we wrote it all
  }

  req.on('data', function(chunk) {
    // If the file is open, just write the current chunk
    if (file) {
      return chunkWrite(chunk);
    }

    // If no file is open, then save the current chunk to the end of the buffer.
    if (!buffer) {
      buffer = chunk;
    } else {
      buffer = Buffer.concat([buffer, chunk]);
    }

    // Found the lengths
    if (sessionlen === -1 && (buffer.length >= 12)) {
      sessionlen = buffer.readUInt32BE(0);
      filelen    = buffer.readUInt32BE(8);
      buffer = buffer.slice(12);
    }

    // If we know the session len and haven't read the session
    if (sessionlen !== -1 && !session && buffer.length >= sessionlen) {
      session = JSON.parse(buffer.toString("utf8", 0, sessionlen));
      session.no = Config.nodeName();
      buffer = buffer.slice(sessionlen);

      if (filelen > 0) {
        req.pause();

        makeFilename(function (filename) {
          req.resume();
          session.ps[0] = - saveId.seq;
          session.fs = [saveId.seq];

          if (saveId.start === 0) {
            file = fs.createWriteStream(filename, {flags: "w"});
          } else {
            file = fs.createWriteStream(filename, {start: saveId.start, flags: "r+"});
          }
          writeHeader = saveId.start === 0;

          // Adjust packet location based on where we start writing
          if (saveId.start > 0) {
            for (var p = 1, plen = session.ps.length; p < plen; p++) {
              session.ps[p] += (saveId.start - 24);
            }
          }

          // Filelen always includes header, if we don't write header subtract it
          saveId.start += filelen;
          if (!writeHeader) {
            saveId.start -= 24;
          }

          // Still more data in buffer, start of pcap
          if (buffer.length > 0) {
            chunkWrite(buffer);
          }

          saveSession();
        });
      } else {
        saveSession();
      }
    }
  });

  req.on('end', function(chunk) {
    if (file) {
      file.end();
    }
    return res.send({success: true});
  });
});

app.post('/sendSessions', function(req, res) {
  if (req.body.ids) {
    var ids = req.body.ids.split(",");

    sessionsListFromIds(req, ids, ["no"], function(err, list) {
      sendSessionsList(req, res, list);
    });
  } else {
    sessionsListFromQuery(req, res, ["no"], function(err, list) {
      sendSessionsList(req, res, list);
    });
  }
});

app.post('/upload', function(req, res) {
  var exec = require('child_process').exec,
      child;

  var tags = "";
  if (req.body.tag) {
    var t = req.body.tag.replace(/[^-a-zA-Z0-9_:,]/g, "").split(",");
    t.forEach(function(tag) {
      if (tag.length > 0) {
        tags += " --tag " + tag;
      }
    });
  }

  var cmd = Config.get("uploadCommand")
              .replace("{TAGS}", tags)
              .replace("{NODE}", Config.nodeName())
              .replace("{TMPFILE}", req.files.file.path)
              .replace("{CONFIG}", Config.getConfigFile());
  console.log("upload command: ", cmd);
  child = exec(cmd, function (error, stdout, stderr) {
    res.write("<b>" + cmd + "</b><br>");
    res.write("<pre>");
    res.write(stdout);
    res.end("</pre>");
    if (error !== null) {
      console.log("exec error: " + error);
    }
    fs.unlink(req.files.file.path);
  });
});

if (Config.get("regressionTests")) {
  app.post('/shutdown', function(req, res) {
    Db.close();
    process.exit(0);
    throw new Error("Exiting");
  });
  app.post('/flushCache', function(req, res) {
    Db.flushCache();
    res.send("{}");
  });
}

//////////////////////////////////////////////////////////////////////////////////
//// Cron Queries
//////////////////////////////////////////////////////////////////////////////////

/* Process a single cron query.  At max it will process 24 hours worth of data
 * to give other queries a chance to run.  It searches for the first time range
 * where there is an available index.
 */
function processCronQuery(cq, options, query, endTime, cb) {

  var singleEndTime;
  var count = 0;
  async.doWhilst(function(whilstCb) {
    // Process at most 24 hours
    singleEndTime = Math.min(endTime, cq.lpValue + 24*60*60);
    query.query.filtered.query.range = {lp: {gt: cq.lpValue, lte: singleEndTime}};

    Db.getIndices(cq.lpValue, singleEndTime, Config.get("rotateIndex", "daily"), function(indices) {

      // There are no matching indices, continue while loop
      if (indices === "sessions-*") {
        cq.lpValue += 24*60*60;
        return setImmediate(whilstCb, null);
      }

      // We have foudn some indices, now scroll thru ES
      Db.search(indices, 'session', query, {scroll: '600s'}, function getMoreUntilDone(err, result) {
        function doNext() {
          count += result.hits.hits.length;

          // No more data, all done
          if (result.hits.hits.length === 0) {
            return setImmediate(whilstCb, "DONE");
          } else {
            var document = { doc: { count: (query.count || 0) + count} };
            Db.update("queries", "query", options.qid, document, {refresh: 1}, function () {});
          }

          Db.scroll({
            body: result._scroll_id,
            scroll: '600s'
          }, getMoreUntilDone);
        }

        if (err || result.error) {
          console.log("cronQuery error", err, (result?result.error:null), "for", cq);
          return setImmediate(whilstCb, "ERR");
        }

        var ids = [];
        var hits = result.hits.hits;
        var i, ilen;
        if (cq.action.indexOf("forward:") === 0) {
          for (i = 0, ilen = hits.length; i < ilen; i++) {
            ids.push({id: hits[i]._id, no: hits[i]._source.no});
          }

          sendSessionsListQL(options, ids, doNext);
        } else if (cq.action.indexOf("tag") === 0) {
          for (i = 0, ilen = hits.length; i < ilen; i++) {
            ids.push(hits[i]._id);
          }
          mapTags(options.tags.split(","), "", function(err, tagIds) {
            sessionsListFromIds(null, ids, ["ta"], function(err, list) {
              addTagsList(tagIds, list, doNext);
            });
          });
        } else {
          console.log("Unknown action", cq);
          doNext();
        }
      });
    });
  }, function () {
    return singleEndTime !== endTime;
  }, function (err) {
    cb(count, singleEndTime);
  });
}

function processCronQueries() {
  if (internals.cronRunning) {
    console.log("processQueries already running", qlworking);
    return;
  }
  internals.cronRunning = true;

  var repeat;
  async.doWhilst(function(whilstCb) {
    repeat = false;
    Db.search("queries", "query", "{size: 1000}", function(err, data) {
      if (err) {
        internals.cronRunning = false;
        console.log("processCronQueries", err);
        return setImmediate(whilstCb, err);
      }
      var queries = {};
      data.hits.hits.forEach(function(item) {
        queries[item._id] = item._source;
      });

      // elasticsearch refresh is 60, so only retrieve older items
      var endTime = Math.floor(Date.now()/1000) - 70;

      // Save incase reload happens while running
      var molochClusters = Config.configMap("moloch-clusters");

      // Go thru the queries, fetch the user, make the query
      async.eachSeries(Object.keys(queries), function (qid, forQueriesCb) {
        var cq = queries[qid];
        var cluster = null;
        var req, res;

        if (!cq.enabled || endTime < cq.lpValue) {
          return forQueriesCb();
        }

        if (cq.action.indexOf("forward:") === 0) {
          cluster = cq.action.substring(8);
        }

        Db.getUserCache(cq.creator, function(err, user) {
          if (err && !user) {return forQueriesCb();}
          if (!user || !user.found) {console.log("User", cq.creator, "doesn't exist"); return forQueriesCb(null);}
          if (!user._source.enabled) {console.log("User", cq.creator, "not enabled"); return forQueriesCb();}
          user = user._source;

          var options = {
            user: user,
            cluster: cluster,
            saveId: Config.nodeName() + "-" + new Date().getTime().toString(36),
            tags: cq.tags.replace(/[^-a-zA-Z0-9_:,]/g, ""),
            qid: qid
          };

          molochparser.parser.yy = {emailSearch: user.emailSearch === true,
                                      fieldsMap: Config.getFieldsMap()};

          var query = {from: 0,
                       size: 500,
                       query: {filtered: {query: {}}},
                       _source: ["_id", "no"]
                      };

          try {
            query.query.filtered.filter = molochparser.parse(cq.query);
          } catch (e) {
            console.log("Couldn't compile cron query expression", cq, e);
            return forQueriesCb();
          }

          if (user.expression && user.expression.length > 0) {
            try {
              // Expression was set by admin, so assume email search ok
              molochparser.parser.yy.emailSearch = true;
              var userExpression = molochparser.parse(user.expression);
              if (query.query.filtered.filter === undefined) {
                query.query.filtered.filter = userExpression;
              } else {
                query.query.filtered.filter = {bool: {must: [userExpression, query.query.filtered.filter]}};
              }
            } catch (e) {
              console.log("Couldn't compile user forced expression", user.expression, e);
              return forQueriesCb();
            }
          }

          lookupQueryItems(query.query.filtered, function (lerr) {
            processCronQuery(cq, options, query, endTime, function (count, lpValue) {
              // Do the ES update
              var document = {
                doc: {
                  lpValue: lpValue,
                  lastRun: Math.floor(Date.now()/1000),
                  count: (queries[qid].count || 0) + count
                }
              };
              Db.update("queries", "query", qid, document, {refresh: 1}, function () {
                // If there is more time to catch up on, repeat the loop, although other queries
                // will get processed first to be fair
                if (lpValue !== endTime) {
                  repeat = true;
                }
                return forQueriesCb();
              });
            });
          });
        });
      }, function(err) {
        return setImmediate(whilstCb, err);
      });
    });
  }, function () {
    return repeat;
  }, function (err) {
    internals.cronRunning = false;
  });
}

//////////////////////////////////////////////////////////////////////////////////
//// Main
//////////////////////////////////////////////////////////////////////////////////
function main () {
  Db.checkVersion(MIN_DB_VERSION, Config.get("passwordSecret") !== undefined);
  Db.healthCache(function(err, health) {
    internals.clusterName = health.cluster_name;
  });

  Db.nodesStats({fs: 1}, function (err, info) {
    info.nodes.timestamp = new Date().getTime();
    internals.previousNodeStats.push(info.nodes);
  });

  expireCheckAll();
  setInterval(expireCheckAll, 60*1000);

  loadFields();
  setInterval(loadFields, 2*60*1000);

  loadPlugins();

  createSessionDetail();
  setInterval(createSessionDetail, 5*60*1000);

  createRightClicks();
  setInterval(createRightClicks, 5*60*1000);

  if (Config.get("cronQueries", false)) {
    console.log("This node will process Cron Queries");
    setInterval(processCronQueries, 60*1000);
    setTimeout(processCronQueries, 1000);
  }

  var server;
  if (Config.isHTTPS()) {
    server = https.createServer({key: fs.readFileSync(Config.get("keyFile")),
                                cert: fs.readFileSync(Config.get("certFile"))}, app);
  } else {
    server = http.createServer(app);
  }

  server
    .on('error', function (e) {
      console.log("ERROR - couldn't listen on port", Config.get("viewPort", "8005"), "is viewer already running?");
      process.exit(1);
      throw new Error("Exiting");
    })
    .on('listening', function (e) {
      console.log("Express server listening on port %d in %s mode", server.address().port, app.settings.env);
    })
    .listen(Config.get("viewPort", "8005"), Config.get("viewHost", undefined));
}
//////////////////////////////////////////////////////////////////////////////////
//// DB
//////////////////////////////////////////////////////////////////////////////////
Db.initialize({host: internals.elasticBase,
               prefix: Config.get("prefix", ""),
               usersHost: Config.get("usersElasticsearch"),
               usersPrefix: Config.get("usersPrefix"),
               nodeName: Config.nodeName(),
               dontMapTags: Config.get("multiES", false)}, main);
