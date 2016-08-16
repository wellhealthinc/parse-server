// FunctionsRouter.js

var express = require('express'),
    Parse = require('parse/node').Parse,
    triggers = require('../triggers');

import PromiseRouter from '../PromiseRouter';
import _ from 'lodash';
import { logger } from '../logger';

function parseObject(obj) {
  if (Array.isArray(obj)) {
      return obj.map((item) => {
        return parseObject(item);
      });
  } else if (obj && obj.__type == 'Date') {
    return Object.assign(new Date(obj.iso), obj);
  } else if (obj && obj.__type == 'File') {
    return Parse.File.fromJSON(obj);
  } else if (obj && typeof obj === 'object') {
    return parseParams(obj);
  } else {
    return obj;
  }
}

function parseParams(params) {
  return _.mapValues(params, parseObject);
}

export class FunctionsRouter extends PromiseRouter {

  mountRoutes() {
    this.route('POST', '/functions/:functionName', FunctionsRouter.handleCloudFunction);
  }

  static createResponseObject(resolve, reject) {
    return {
      success: function(result) {
        resolve({
          response: {
            result: Parse._encode(result)
          }
        });
      },
      error: function(code, message) {
        if (!message) {
          message = code;
          code = Parse.Error.SCRIPT_FAILED;
        }
        reject(new Parse.Error(code, message));
      }
    }
  }

  static handleCloudFunction(req) {
    var applicationId = req.config.applicationId;
    var theFunction = triggers.getFunction(req.params.functionName, applicationId);
    var theValidator = triggers.getValidator(req.params.functionName, applicationId);
    if (theFunction) {
      let params = Object.assign({}, req.body, req.query);
      params = parseParams(params);
      var request = {
        params: params,
        master: req.auth && req.auth.isMaster,
        user: req.auth && req.auth.user,
        installationId: req.info.installationId,
        log: req.config.loggerController,
        headers: req.headers,
        functionName: req.params.functionName
      };

      if (theValidator && typeof theValidator === "function") {
        var result = theValidator(request);
        if (!result) {
          throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'Validation failed.');
        }
      }

      return new Promise(function (resolve, reject) {
        var response = FunctionsRouter.createResponseObject((result) => {
          logger.info(`Ran cloud function ${req.params.functionName} with:\nInput: ${JSON.stringify(params)}\nResult: ${JSON.stringify(result.response.result)}`, {
            functionName: req.params.functionName,
            params,
            result: result.response.result
          });
          resolve(result);
        }, (error) => {
          logger.error(`Failed running cloud function ${req.params.functionName} with:\nInput: ${JSON.stringify(params)}\Error: ${JSON.stringify(error)}`, {
            functionName: req.params.functionName,
            params,
            error
          });
          reject(error);
        });
        // Force the keys before the function calls.
        Parse.applicationId = req.config.applicationId;
        Parse.javascriptKey = req.config.javascriptKey;
        Parse.masterKey = req.config.masterKey;
        theFunction(request, response);
      });
    } else {
      throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'Invalid function.');
    }
  }
}
