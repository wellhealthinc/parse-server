// ParseServer - open-source compatible API Server for Parse apps

var batch = require('./batch'),
    bodyParser = require('body-parser'),
    express = require('express'),
    middlewares = require('./middlewares'),
    multer = require('multer'),
    Parse = require('parse/node').Parse,
    path = require('path'),
    authDataManager = require('./authDataManager');

if (!global._babelPolyfill) {
  require('babel-polyfill');
}

import defaults                 from './defaults';
import * as logging             from './logger';
import AppCache                 from './cache';
import Config                   from './Config';
import parseServerPackage       from '../package.json';
import PromiseRouter            from './PromiseRouter';
import requiredParameter        from './requiredParameter';
import { AnalyticsRouter }      from './Routers/AnalyticsRouter';
import { ClassesRouter }        from './Routers/ClassesRouter';
import { FeaturesRouter }       from './Routers/FeaturesRouter';
import { InMemoryCacheAdapter } from './Adapters/Cache/InMemoryCacheAdapter';
import { AnalyticsController }  from './Controllers/AnalyticsController';
import { CacheController }      from './Controllers/CacheController';
import { AnalyticsAdapter }     from './Adapters/Analytics/AnalyticsAdapter';
import { WinstonLoggerAdapter } from './Adapters/Logger/WinstonLoggerAdapter';
import { FilesController }      from './Controllers/FilesController';
import { FilesRouter }          from './Routers/FilesRouter';
import { FunctionsRouter }      from './Routers/FunctionsRouter';
import { GlobalConfigRouter }   from './Routers/GlobalConfigRouter';
import { GridStoreAdapter }     from './Adapters/Files/GridStoreAdapter';
import { HooksController }      from './Controllers/HooksController';
import { HooksRouter }          from './Routers/HooksRouter';
import { IAPValidationRouter }  from './Routers/IAPValidationRouter';
import { InstallationsRouter }  from './Routers/InstallationsRouter';
import { loadAdapter }          from './Adapters/AdapterLoader';
import { LiveQueryController }  from './Controllers/LiveQueryController';
import { LoggerController }     from './Controllers/LoggerController';
import { LogsRouter }           from './Routers/LogsRouter';
import { ParseLiveQueryServer } from './LiveQuery/ParseLiveQueryServer';
import { PublicAPIRouter }      from './Routers/PublicAPIRouter';
import { PushController }       from './Controllers/PushController';
import { PushRouter }           from './Routers/PushRouter';
import { randomString }         from './cryptoUtils';
import { RolesRouter }          from './Routers/RolesRouter';
import { SchemasRouter }        from './Routers/SchemasRouter';
import { SessionsRouter }       from './Routers/SessionsRouter';
import { UserController }       from './Controllers/UserController';
import { UsersRouter }          from './Routers/UsersRouter';
import { PurgeRouter }          from './Routers/PurgeRouter';

import DatabaseController       from './Controllers/DatabaseController';
import SchemaCache              from './Controllers/SchemaCache';
import ParsePushAdapter         from 'parse-server-push-adapter';
import MongoStorageAdapter      from './Adapters/Storage/Mongo/MongoStorageAdapter';
// Mutate the Parse object to add the Cloud Code handlers
addParseCloud();

// ParseServer works like a constructor of an express app.
// The args that we understand are:
// "analyticsAdapter": an adapter class for analytics
// "filesAdapter": a class like GridStoreAdapter providing create, get,
//                 and delete
// "loggerAdapter": a class like WinstonLoggerAdapter providing info, error,
//                 and query
// "jsonLogs": log as structured JSON objects
// "databaseURI": a uri like mongodb://localhost:27017/dbname to tell us
//          what database this Parse API connects to.
// "cloud": relative location to cloud code to require, or a function
//          that is given an instance of Parse as a parameter.  Use this instance of Parse
//          to register your cloud code hooks and functions.
// "appId": the application id to host
// "masterKey": the master key for requests to this app
// "facebookAppIds": an array of valid Facebook Application IDs, required
//                   if using Facebook login
// "collectionPrefix": optional prefix for database collection names
// "fileKey": optional key from Parse dashboard for supporting older files
//            hosted by Parse
// "clientKey": optional key from Parse dashboard
// "dotNetKey": optional key from Parse dashboard
// "restAPIKey": optional key from Parse dashboard
// "webhookKey": optional key from Parse dashboard
// "javascriptKey": optional key from Parse dashboard
// "push": optional key from configure push
// "sessionLength": optional length in seconds for how long Sessions should be valid for

class ParseServer {

  constructor({
    appId = requiredParameter('You must provide an appId!'),
    masterKey = requiredParameter('You must provide a masterKey!'),
    appName,
    analyticsAdapter,
    filesAdapter,
    push,
    loggerAdapter,
    jsonLogs = defaults.jsonLogs,
    logsFolder = defaults.logsFolder,
    verbose = defaults.verbose,
    logLevel = defaults.level,
    silent = defaults.silent,
    databaseURI = defaults.DefaultMongoURI,
    databaseOptions,
    databaseAdapter,
    cloud,
    collectionPrefix = '',
    clientKey,
    javascriptKey,
    dotNetKey,
    restAPIKey,
    webhookKey,
    fileKey,
    facebookAppIds = [],
    enableAnonymousUsers = defaults.enableAnonymousUsers,
    allowClientClassCreation = defaults.allowClientClassCreation,
    oauth = {},
    serverURL = requiredParameter('You must provide a serverURL!'),
    maxUploadSize = defaults.maxUploadSize,
    verifyUserEmails = defaults.verifyUserEmails,
    preventLoginWithUnverifiedEmail = defaults.preventLoginWithUnverifiedEmail,
    emailVerifyTokenValidityDuration,
    cacheAdapter,
    emailAdapter,
    publicServerURL,
    customPages = {
      invalidLink: undefined,
      verifyEmailSuccess: undefined,
      choosePassword: undefined,
      passwordResetSuccess: undefined
    },
    liveQuery = {},
    sessionLength = defaults.sessionLength, // 1 Year in seconds
    expireInactiveSessions = defaults.expireInactiveSessions,
    revokeSessionOnPasswordReset = defaults.revokeSessionOnPasswordReset,
    schemaCacheTTL = defaults.schemaCacheTTL, // cache for 5s
    __indexBuildCompletionCallbackForTests = () => {},
  }) {
    // Initialize the node client SDK automatically
    Parse.initialize(appId, javascriptKey || 'unused', masterKey);
    Parse.serverURL = serverURL;
    if ((databaseOptions || (databaseURI && databaseURI != defaults.DefaultMongoURI) || collectionPrefix !== '') && databaseAdapter) {
      throw 'You cannot specify both a databaseAdapter and a databaseURI/databaseOptions/connectionPrefix.';
    } else if (!databaseAdapter) {
      databaseAdapter = new MongoStorageAdapter({
        uri: databaseURI,
        collectionPrefix,
        mongoOptions: databaseOptions,
      });
    } else {
      databaseAdapter = loadAdapter(databaseAdapter)
    }

    if (!filesAdapter && !databaseURI) {
      throw 'When using an explicit database adapter, you must also use and explicit filesAdapter.';
    }

    const loggerControllerAdapter = loadAdapter(loggerAdapter, WinstonLoggerAdapter, { jsonLogs, logsFolder, verbose, logLevel, silent });
    const loggerController = new LoggerController(loggerControllerAdapter, appId);
    logging.setLogger(loggerController);

    const filesControllerAdapter = loadAdapter(filesAdapter, () => {
      return new GridStoreAdapter(databaseURI);
    });
    const filesController = new FilesController(filesControllerAdapter, appId);

    // Pass the push options too as it works with the default
    const pushControllerAdapter = loadAdapter(push && push.adapter, ParsePushAdapter, push || {});
    // We pass the options and the base class for the adatper,
    // Note that passing an instance would work too
    const pushController = new PushController(pushControllerAdapter, appId, push);

    const emailControllerAdapter = loadAdapter(emailAdapter);
    const userController = new UserController(emailControllerAdapter, appId, { verifyUserEmails });

    const cacheControllerAdapter = loadAdapter(cacheAdapter, InMemoryCacheAdapter, {appId: appId});
    const cacheController = new CacheController(cacheControllerAdapter, appId);

    const analyticsControllerAdapter = loadAdapter(analyticsAdapter, AnalyticsAdapter);
    const analyticsController = new AnalyticsController(analyticsControllerAdapter);

    const liveQueryController = new LiveQueryController(liveQuery);
    const databaseController = new DatabaseController(databaseAdapter, new SchemaCache(cacheController, schemaCacheTTL));
    const hooksController = new HooksController(appId, databaseController, webhookKey);

    const dbInitPromise = databaseController.performInitizalization();

    AppCache.put(appId, {
      appId,
      masterKey: masterKey,
      serverURL: serverURL,
      collectionPrefix: collectionPrefix,
      clientKey: clientKey,
      javascriptKey: javascriptKey,
      dotNetKey: dotNetKey,
      restAPIKey: restAPIKey,
      webhookKey: webhookKey,
      fileKey: fileKey,
      facebookAppIds: facebookAppIds,
      analyticsController: analyticsController,
      cacheController: cacheController,
      filesController: filesController,
      pushController: pushController,
      loggerController: loggerController,
      hooksController: hooksController,
      userController: userController,
      verifyUserEmails: verifyUserEmails,
      preventLoginWithUnverifiedEmail: preventLoginWithUnverifiedEmail,
      emailVerifyTokenValidityDuration: emailVerifyTokenValidityDuration,
      allowClientClassCreation: allowClientClassCreation,
      authDataManager: authDataManager(oauth, enableAnonymousUsers),
      appName: appName,
      publicServerURL: publicServerURL,
      customPages: customPages,
      maxUploadSize: maxUploadSize,
      liveQueryController: liveQueryController,
      sessionLength: Number(sessionLength),
      expireInactiveSessions: expireInactiveSessions,
      jsonLogs,
      revokeSessionOnPasswordReset,
      databaseController,
      schemaCacheTTL
    });

    // To maintain compatibility. TODO: Remove in some version that breaks backwards compatability
    if (process.env.FACEBOOK_APP_ID) {
      AppCache.get(appId)['facebookAppIds'].push(process.env.FACEBOOK_APP_ID);
    }

    Config.validate(AppCache.get(appId));
    this.config = AppCache.get(appId);
    hooksController.load();

    // Note: Tests will start to fail if any validation happens after this is called.
    if (process.env.TESTING) {
      __indexBuildCompletionCallbackForTests(dbInitPromise);
    }

    if (cloud) {
      addParseCloud();
      if (typeof cloud === 'function') {
        cloud(Parse)
      } else if (typeof cloud === 'string') {
        require(path.resolve(process.cwd(), cloud));
      } else {
        throw "argument 'cloud' must either be a string or a function";
      }
    }
  }

  get app() {
    return ParseServer.app(this.config);
  }

  static app({maxUploadSize = '20mb', appId}) {
    // This app serves the Parse API directly.
    // It's the equivalent of https://api.parse.com/1 in the hosted Parse API.
    var api = express();
    //api.use("/apps", express.static(__dirname + "/public"));
    // File handling needs to be before default middlewares are applied
    api.use('/', middlewares.allowCrossDomain, new FilesRouter().expressRouter({
      maxUploadSize: maxUploadSize
    }));

    api.use('/', bodyParser.urlencoded({extended: false}), new PublicAPIRouter().expressRouter());

    api.use(bodyParser.json({ 'type': '*/*' , limit: maxUploadSize }));
    api.use(middlewares.allowMethodOverride);

    let routers = [
      new ClassesRouter(),
      new UsersRouter(),
      new SessionsRouter(),
      new RolesRouter(),
      new AnalyticsRouter(),
      new InstallationsRouter(),
      new FunctionsRouter(),
      new SchemasRouter(),
      new PushRouter(),
      new LogsRouter(),
      new IAPValidationRouter(),
      new FeaturesRouter(),
      new GlobalConfigRouter(),
      new PurgeRouter(),
      new HooksRouter()
    ];

    let routes = routers.reduce((memo, router) => {
      return memo.concat(router.routes);
    }, []);

    let appRouter = new PromiseRouter(routes, appId);
    appRouter.use(middlewares.allowCrossDomain);
    appRouter.use(middlewares.handleParseHeaders);
    
    batch.mountOnto(appRouter);

    api.use(appRouter.expressRouter());

    api.use(middlewares.handleParseErrors);

    //This causes tests to spew some useless warnings, so disable in test
    if (!process.env.TESTING) {
      process.on('uncaughtException', (err) => {
        if ( err.code === "EADDRINUSE" ) { // user-friendly message for this common error
          console.error(`Unable to listen on port ${err.port}. The port is already in use.`);
          process.exit(0);
        } else {
          throw err;
        }
      });
    }
    return api;
  }

  static createLiveQueryServer(httpServer, config) {
    return new ParseLiveQueryServer(httpServer, config);
  }
}

function addParseCloud() {
  const ParseCloud = require("./cloud-code/Parse.Cloud");
  Object.assign(Parse.Cloud, ParseCloud);
  global.Parse = Parse;
}

export default ParseServer;
