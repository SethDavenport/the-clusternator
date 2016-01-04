'use strict';
const Q = require('q');
const Subnet = require('./subnetManager');
const SG = require('./securityGroupManager');
const Ec2 = require('./ec2Manager');
const rid = require('./../resourceIdentifier');
const Cluster = require('./clusterManager');
const Route53 = require('./route53Manager');
const Task = require('./taskServiceManager');
const common = require('./common');
const constants = require('../constants');
const path = require('path');
const util = require('../util');
const elbFns = require('./elb/elb');
const R = require('ramda');

function getDeploymentManager(ec2, ecs, r53, awsElb, vpcId, zoneId) {
  var subnet = Subnet(ec2, vpcId);
  var securityGroup = SG(ec2, vpcId);
  var cluster = Cluster(ecs);
  var route53 = Route53(r53, zoneId);
  var ec2mgr = Ec2(ec2, vpcId);
  var task = Task(ecs);
  var elb = R.mapObjIndexed(elbAwsPartial, elbFns);

  function elbAwsPartial(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    return R.partial(fn, { elb: util.makePromiseApi(awsElb) });
  }

  function createEc2(groupId, clusterName, pid, deployment, subnetId, sha) {
    return ec2mgr.createDeployment({
        clusterName: clusterName,
        pid: pid,
        deployment: deployment,
        sha: sha,
        sgId: groupId,
        subnetId: subnetId,
        sshPath: path.join('.private', constants.SSH_PUBLIC_PATH),
        apiConfig: {}
      });
  }

  function getIdFromEc2Results(results) {
    if (!results[0]) {
      throw new Error('createPR: unexpected EC2 create results');
    }
    var instanceId = '';
    results[0].Instances.forEach((inst) => {
       instanceId = inst.InstanceId;
    });
    return instanceId;
  }

  function createElbEc2(groupId, clusterName, pid, deployment, subnetId, sha) {
    return Q.all([
        createEc2(groupId, clusterName, pid, deployment, subnetId, sha),
        elb.createDeployment(pid, deployment, subnetId, groupId,
          constants.AWS_SSL_ID) ])
      .then((results) => Q.all([
          route53
            .createDeploymentCNameRecord(
              pid, deployment, results[1].dns),
          elb.registerInstances(
            results[1].id, [getIdFromEc2Results(results[0])]),
          elb.configureHealthCheck(results[1].id) ])
        .then((results) => results[0])
        // fail over
        .fail(() => undefined));
  }

  function createEc2Solo(groupId, clusterName, pid, deployment, subnetId, sha) {
    return createEc2(groupId, clusterName, pid, deployment, subnetId, sha)
      .then((ec2Results) => route53
        .createDeploymentARecord(
          pid, deployment, common.findIpFromEc2Describe(ec2Results))
        .then((urlDesc) => urlDesc)
        // fail over
        .fail(() => undefined));
  }

  /**
   * @param {string} subnetId
   * @param {string} pid
   * @param {string} deployment
   * @param {string} sha
   * @param {Object} appDef
   * @returns {Request}
   */
  function createCluster(subnetId, pid, deployment, sha, appDef) {
    var clusterName = rid.generateRID({
      pid,
      deployment,
      sha
    });

    return Q
      .all([
        securityGroup.createDeployment(pid, deployment, sha),
        cluster.create(clusterName)
      ])
      .then((results) => createElbEc2(results[0].GroupId, clusterName, pid,
        deployment, subnetId, sha))
      .then((urlDesc) => task
        .create(clusterName, clusterName, appDef)
        .then(() => urlDesc));
    //- start system
  }

  function create(projectId, deployment, sha, appDef) {
    return subnet
      .describeProject(projectId)
      .then((list) => {
        if (!list.length) {
          throw new Error('Create Deployment failed, no subnet found for ' +
            `Project: ${projectId} Deployment ${deployment}`);
        }
        return createCluster(
          list[0].SubnetId, projectId, deployment, sha, appDef);
      });
  }

  /**
   * @param {string} projectId
   * @param {string} deployment
   * @param {string} clusterName
   * @returns {Promise.<string[]>}
   */
  function destroyEc2(projectId, deployment, clusterName) {
    if (!clusterName) {
      throw new Error('destroyEc2: requires valid clusterName');
    }
    return cluster
      .listContainers(clusterName)
      .then((result) => Q
        .all(result.map(common.getDeregisterClusterFn(cluster, clusterName)))
        .then(() => ec2mgr
          .destroyDeployment(projectId, deployment)
          .fail((err) => {
            util.info('Deployment Destruction Problem Destroying Ec2: ' +
              err.message);
          })));
  }

  /**
   * @param {string} projectId
   * @param {string} deployment
   * @returns {Request|Promise.<T>}
   */
  function destroyRoutes(projectId, deployment) {
    return ec2mgr
      .describeDeployment(projectId, deployment)
      .then((results) => {
        var ip = common.findIpFromEc2Describe(results);
        return route53.destroyDeploymentARecord(projectId, deployment, ip);
      });
  }

  function destroyElb(projectId, deployment) {
    return elb.destroyDeployment(projectId, deployment)
      //fail over
      .fail(() => undefined);
  }

  /**
   * @param {string} projectId
   * @param {string} deployment
   * @param {string} sha
   * @returns {Request}
   */
  function destroy(projectId, deployment, sha) {
    var clusterName = rid.generateRID({
      pid: projectId,
      deployment,
      sha
    });
    return destroyRoutes(projectId, deployment)
      .then(() => destroyEc2(projectId, deployment, clusterName),
        () => destroyEc2(projectId, deployment, clusterName))
      .then(() => destroyElb(projectId, deployment))
      .then((r) => task
        .destroy(clusterName)
        .fail((err) => {
          util.info('Deployment Destruction Problem Destroying Task: ' +
            err.message);
        }))
      .then(() => cluster
        .destroy(clusterName)
        // fail over
        .fail(() => undefined))
      .then(() => securityGroup
        .destroyDeployment(projectId, deployment)
        // fail over
        .fail(() => undefined));
  }

  return {
    create: create,
    destroy: destroy
  };
}

module.exports = getDeploymentManager;
