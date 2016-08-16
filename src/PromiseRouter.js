// A router that is based on promises rather than req/res/next.
// This is intended to replace the use of express.Router to handle
// subsections of the API surface.
// This will make it easier to have methods like 'batch' that
// themselves use our routing information, without disturbing express
// components that external developers may be modifying.

import AppCache  from './cache';
import express   from 'express';
import url       from 'url';
import log       from './logger';
import {inspect} from 'util';

export default class PromiseRouter {
  // Each entry should be an object with:
  // path: the path to route, in express format
  // method: the HTTP method that this route handles.
  //   Must be one of: POST, GET, PUT, DELETE
  // handler: a function that takes request, and returns a promise.
  //   Successful handlers should resolve to an object with fields:
  //     status: optional. the http status code. defaults to 200
  //     response: a json object with the content of the response
  //     location: optional. a location header
  constructor(routes = [], appId) {
    this.routes = routes;
    this.middlewares = [];
    this.appId = appId;
    this.mountRoutes();
  }

  // Leave the opportunity to
  // subclasses to mount their routes by overriding
  mountRoutes() {}

  // Merge the routes into this one
  merge(router) {
    for (var route of router.routes) {
      this.routes.push(route);
    }
  };

  use(middleware) {
    this.middlewares.push(middleware);
  }

  route(method, path, ...handlers) {
    switch(method) {
    case 'POST':
    case 'GET':
    case 'PUT':
    case 'DELETE':
      break;
    default:
      throw 'cannot route method: ' + method;
    }

    let handler = handlers[0];

    if (handlers.length > 1) {
      const length = handlers.length;
      handler = function(req) {
        return handlers.reduce((promise, handler) => {
          return promise.then((result) => {
            return handler(req);
          });
        }, Promise.resolve());
      }
    }

    this.routes.push({
      path: path,
      method: method,
      handler: handler
    });
  };

  // Returns an object with:
  //   handler: the handler that should deal with this request
  //   params: any :-params that got parsed from the path
  // Returns undefined if there is no match.
  match(method, path) {
    for (var route of this.routes) {
      if (route.method != method) {
        continue;
      }
      // NOTE: we can only route the specific wildcards :className and
      // :objectId, and in that order.
      // This is pretty hacky but I don't want to rebuild the entire
      // express route matcher. Maybe there's a way to reuse its logic.
      var pattern = '^' + route.path + '$';

      pattern = pattern.replace(':className',
                                '(_?[A-Za-z][A-Za-z_0-9]*)');
      pattern = pattern.replace(':objectId',
                                '([A-Za-z0-9]+)');
      var re = new RegExp(pattern);
      var m = path.match(re);
      if (!m) {
        continue;
      }
      var params = {};
      if (m[1]) {
        params.className = m[1];
      }
      if (m[2]) {
        params.objectId = m[2];
      }

      return {params: params, handler: route.handler};
    }
  };

  // Mount the routes on this router onto an express app (or express router)
  mountOnto(expressApp) {
    this.routes.forEach((route) => {
      let method = route.method.toLowerCase();
      let handler = makeExpressHandler(this.appId, route.handler);
      let args = [].concat(route.path, this.middlewares, handler);
      expressApp[method].apply(expressApp, args);
    });
    return expressApp;
  };

  expressRouter() {
    return this.mountOnto(express.Router());
  }
}

// A helper function to make an express handler out of a a promise
// handler.
// Express handlers should never throw; if a promise handler throws we
// just treat it like it resolved to an error.
function makeExpressHandler(appId, promiseHandler) {
  let config = AppCache.get(appId);
  return function(req, res, next) {
    try {
      let url = maskSensitiveUrl(req);
      let body = maskSensitiveBody(req);
      let stringifiedBody = JSON.stringify(body, null, 2);
      log.verbose(`REQUEST for [${req.method}] ${url}: ${stringifiedBody}`, {
        method: req.method,
        url: url,
        headers: req.headers,
        body: body
      });
      promiseHandler(req).then((result) => {
        if (!result.response && !result.location && !result.text) {
          log.error('the handler did not include a "response" or a "location" field');
          throw 'control should not get here';
        }

        let stringifiedResponse = JSON.stringify(result, null, 2);
        log.verbose(
          `RESPONSE from [${req.method}] ${url}: ${stringifiedResponse}`,
          {result: result}
        );

        var status = result.status || 200;
        res.status(status);

        if (result.text) {
          res.send(result.text);
          return next();
        }

        if (result.location) {
          res.set('Location', result.location);
          // Override the default expressjs response
          // as it double encodes %encoded chars in URL
          if (!result.response) {
            res.send('Found. Redirecting to '+result.location);
            return next();
          }
        }
        if (result.headers) {
          Object.keys(result.headers).forEach((header) => {
            res.set(header, result.headers[header]);
          })
        }
        res.json(result.response);
        next();
      }, (e) => {
        log.error(`Error generating response. ${inspect(e)}`, {error: e});
        next(e);
      });
    } catch (e) {
      log.error(`Error handling request: ${inspect(e)}`, {error: e});
      next(e);
    }
  }
}

function maskSensitiveBody(req) {
  let maskBody = Object.assign({}, req.body);
  let shouldMaskBody = (req.method === 'POST' && req.originalUrl.endsWith('/users')
                       && !req.originalUrl.includes('classes')) ||
                       (req.method === 'PUT' && /users\/\w+$/.test(req.originalUrl)
                       && !req.originalUrl.includes('classes')) ||
                       (req.originalUrl.includes('classes/_User'));
  if (shouldMaskBody) {
    for (let key of Object.keys(maskBody)) {
      if (key == 'password') {
        maskBody[key] = '********';
        break;
      }
    }
  }
  return maskBody;
}

function maskSensitiveUrl(req) {
  let maskUrl = req.originalUrl.toString();
  let shouldMaskUrl = req.method === 'GET' && req.originalUrl.includes('/login')
                      && !req.originalUrl.includes('classes');
  if (shouldMaskUrl) {
    let password = url.parse(req.originalUrl, true).query.password;
    if (password) {
      maskUrl = maskUrl.replace('password=' + password, 'password=********')
    }
  }
  return maskUrl;
}
