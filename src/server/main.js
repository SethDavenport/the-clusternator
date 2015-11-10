'use strict';

const TEST_VPC = 'vpc-ab07b4cf';
const TEST_ZONE = 'us-east-1';

var q = require('q');
var express = require('express');
var bodyParser = require('body-parser');
var aws = require('aws-sdk');

var getPRManager = require('../prManager');

var prHandler = require('./pullRequest');
var pushHandler = require('./push');
var loggers = require('./loggers');

function createServer(prManager) {
  var app = express();

  function ping(req, res) {
    res.send('Still alive.');
  }

  // SSL
  // Auth

  app.use(bodyParser.json());
  app.use(loggers.request);

  app.post('/clusternate', pushHandler); // CI post-build hook
  app.post('/github/pr', prHandler);     // github close PR hook

  app.use(loggers.error);

  return app;
}

// XXX
// This function is here to force the PR manager to load asynchronously,
// such that we can query for a VPC ID before starting (as opposed to
// using a hardcoded one right now).
//
function loadPRManagerAsync(config) {
  var ec2 = new aws.EC2(config.credentials);
  var ecs = new aws.ECS(config.credentials);
  var r53 = new aws.Route53(config.credentials);
  var prm = getPRManager(ec2, ecs, r53, TEST_VPC, TEST_ZONE);
  return q.resolve(prm);
}

function getServer(config) {
  return loadPRManagerAsync(config)
          .then(createServer, (err) => {
            return q.reject(err);
          });
}

function startServer(config) {
  // wtf
  getServer(config)
    .then((server) => {
      server.listen(config.port); 
      console.log('Clusternator listening on port', config.port)
    });
}

module.exports = {
  getServer: getServer,
  startServer: startServer
};
