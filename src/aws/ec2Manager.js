'use strict';
/**
 * Internal aws resource for managing ec2s
 *
 * @module aws/ec2Manager
 */

const UTF8 = 'utf8';
const SETUP_SSH = 'mkdir -p /home/ec2-user/.ssh';
const CHOWN_SSH ='chown -R ec2-user:ec2-user /home/ec2-user/.ssh && chmod -R ' +
  'go-rwx /home/ec2-user/.ssh';
const OUTPUT_SSH = '>> /home/ec2-user/.ssh/authorized_keys';
const Config = require('../config');
const configAttributes = ['clusterName', 'sgId', 'subnetId', 'pid'];
const prConfigAttributes = configAttributes.concat(['pr']);
const deploymentConfigAttributes = configAttributes.concat(
  ['deployment']);

const Q = require('q');
const R = require('ramda');
const common = require('./common');
const ec2Skeletons = require('./ec2Skeletons');
const util = require('../util');
const constants = require('../constants');
const awsConstants = require('./aws-constants');
const fs = require('fs');
const path = require('path');

const ls = Q.nbind(fs.readdir, fs);
const readFile = Q.nbind(fs.readFile, fs);
const DEFAULT_INSTANCE_PARAMS = ec2Skeletons.AWS_DEFAULT_EC2;


/**
 * Loads _all_ the contents of a given path, it assumes they're public keys
 * @param {string} keyPath
 * @returns {Promise<string[]>}
 */
function loadUserPublicKeys(keyPath) {
  return ls(keyPath).then((keyFiles) => {
    return Q.all(keyFiles.map((fileName) => {
      return readFile(path.join(keyPath, fileName), UTF8);
    }));
  });
}

/**
 * @param {string} type
 * @returns {string}
 */
function makeDockerAuthType(type) {
  return `echo ECS_ENGINE_AUTH_TYPE=${ type } >> /etc/ecs/ecs.config;`;
}

/**
 * @param {string} data
 * @returns {string}
 */
function makeDockerAuthData(data) {
  return `echo ECS_ENGINE_AUTH_DATA=${ data } >> /etc/ecs/ecs.config;`;
}

/**
 * @todo sort out docker auth for private images
 * @param {string} cfg
 * @returns {string[]}
 */
function makeDockerAuthCfg(cfg) {
  if (!cfg) {
    throw new TypeError('Clusternator Ec2: makeDockerAuthCfg requires a param');
  }
  const cfgType = 'dockercfg';
  return [
    makeDockerAuthType(cfgType),
    makeDockerAuthData(cfg)
  ];
}


/**
 * @todo sort out docker auth for private images
 * @param {{ username: string, password: string, email: string }}auth
 * @return {string[]}
 * @throws {TypeError}
 */
function makeDockerAuth(auth) {
  if (!auth || !auth.username || !auth.password || !auth.email) {
    throw new TypeError('Clusternator: Ec2: Auth should contain a ' +
      'username, password, and email');
  }
  const cfgType = 'docker';

  const authJson = {
    'https://index.docker.io/v1/user': auth
  };
  const authStr = JSON.stringify(authJson);

  return [
    makeDockerAuthType(cfgType),
    makeDockerAuthData(authStr)
  ];
}

/**
 * @param {string[]} keys
 * @returns {string[]}
 */
function processSSHKeys(keys) {
  if (!keys.length) {
    return [];
  }
  return [SETUP_SSH].concat(keys.map((key) => {
    return `echo "\n${key}" ${OUTPUT_SSH}`;
  }).concat(CHOWN_SSH));
}

/**
 * @param {string} sshPath to user defined ssh public keys
 * @returns {Promise<string[]>}
 */
function makeSSHUserData(sshPath) {
  return loadUserPublicKeys(sshPath)
    .then(processSSHKeys);
}


/**
 * @param {string[]} arr
 * @return {string}
 */
function stringArrayToNewLineBase64(arr) {
  const buf = new Buffer(arr.join('\n'));
  return buf.toString('base64');
}

/**
 * @param {string} clusterName
 * @param {{ username: string, password: string,
 email:string}|{cfg:string}} auth
 * @param {string|string[]} sshDataOrPath
 * @returns {Promise<string>}
 */
function getECSContainerInstanceUserData(clusterName, auth, sshDataOrPath) {
  let  data = ['#!/bin/bash',
    'echo ECS_CLUSTER=' + clusterName + ' >> /etc/ecs/ecs.config;'
  ];
  let authData = [];

  if (auth) {
    if (auth.cfg) {
      authData = makeDockerAuthCfg(auth.cfg);
    } else {
      authData = makeDockerAuth(auth);
    }
  }

  data = data.concat(authData);

  if (Array.isArray(sshDataOrPath)) {
    data = data.concat(processSSHKeys(sshDataOrPath));
    return Q.resolve(stringArrayToNewLineBase64(data));
  }

  return makeSSHUserData(sshDataOrPath)
    .then((sshData) => {
      data = data.concat(sshData);
      return stringArrayToNewLineBase64(data);
    }, (err) => {
      //util.info('Clusternator Ec2: Warning: Loading user defined SSH keys ' +
      //  'failed, custom logins disabled ' + err.message);

      util.info(`Notice, no user keys found in .private/
    ${constants.SSH_PUBLIC_PATH}, logging '*not* possible`);
      return stringArrayToNewLineBase64(data);
    });
}


function getEC2Manager(ec2, vpcId) {
  ec2 = util.makePromiseApi(ec2);

  const baseFilters = awsConstants.AWS_FILTER_CTAG.concat(
    common.makeAWSVPCFilter(vpcId));
  const describe = common.makeEc2DescribeFn(
      ec2, 'describeInstances', 'Reservations', baseFilters);
  const describeProject = common.makeEc2DescribeProjectFn(describe);
  const describePr = common.makeEc2DescribePrFn(describe);
  const describeDeployment = common.makeEc2DescribeDeployment(describe);

  /**
   * @param {string} instance
   * @param {string} pr
   * @param {string} pid
   * @returns {Promise}
   */
  function tagPrInstance(instance, pr, pid) {
    const config = Config();

    return common.awsTagEc2(ec2, instance.InstanceId, [{
      Key: constants.CLUSTERNATOR_TAG,
      Value: 'true'
    }, {
      Key: constants.PR_TAG,
      Value: pr + ''
    }, {
      Key: constants.PROJECT_TAG,
      Value: pid + ''
    }, {
      Key: constants.EXPIRES_TAG,
      Value: (Date.now() + (config.prTTL || 259200000)) + ''
    }]);
  }

  /**
   * @param {string} instance
   * @param {string} deployment
   * @param {string} pid
   * @returns {Promise}
   */
  function tagDeploymentInstance(instance, deployment, pid) {
    return common.awsTagEc2(ec2, instance.InstanceId, [{
      Key: constants.CLUSTERNATOR_TAG,
      Value: 'true'
    }, {
      Key: constants.DEPLOYMENT_TAG,
      Value: deployment
    }, {
      Key: constants.PROJECT_TAG,
      Value: pid
    }]);
  }




  /**
   *  @param {string[]|string} instanceIds
   */
  function checkInstanceStatuses(instanceIds) {
    if (!Array.isArray(instanceIds)) {
      instanceIds = [instanceIds];
    }
    if (!instanceIds.length) {
      throw 'No instance IDs';
    }

    const params = {
      InstanceIds: instanceIds
    };

    return ec2.describeInstances(params).then(function(list) {
      if (!list.Reservations.length) {
        return [];
      }

      const res = list.Reservations[0].Instances;
      return res.map((reservation) => {
        return {
          InstanceId: reservation.instanceIds,
          State: reservation.State,
          Tags: reservation.Tags
        };
      });
    });
  }

  function makeTerminatedPredicate(instanceIds) {
    function predicate() {
      return checkInstanceStatuses(instanceIds).then((list) => {
        if (!list.length) {
          throw new Error('Ec2 Could not wait for ' + instanceIds.join(', ') +
            ' to terminate, they were not found');
        }
        if (list[0].State.Name === 'terminated') {
          util.info('Ec2: Instances ' + instanceIds.join(', ') + ' Terminated');
          return true;
        } else {
          throw new Error('Ec2: Not Yet Terminated');
        }
      });
    }
    return predicate;
  }

  function makeReadyPredicate(instanceId) {
    function predicate() {
      return checkInstanceStatuses([instanceId]).then((list) => {
        if (!list.length) {
          throw new Error('Ec2 No Instances Awaiting Readiness');
        }
        if (list[0].State.Name === 'running') {
          util.info('Ec2 Is Ready');
          return true;
        } else {
          throw new Error('Ec2: Wait For Readiness');
        }
      });
    }
    return predicate;
  }

  /**
   @param {string} instanceId
   */
  function waitForReady(instanceId) {
    const fn = makeReadyPredicate(instanceId);

    return util.waitFor(fn, awsConstants.AWS_EC2_POLL_INTERVAL,
      awsConstants.AWS_EC2_POLL_MAX);
  }

  /**
   * @param {{ clusterName: string, sgId: string, subnetId: string,
   * pid: string, deployment: string }} config
   * @throws {Error}
   */
  function validateCreateDeploymentConfig(config) {
    if (!config) {
      throw new TypeError('This function requires a configuration object');
    }
    deploymentConfigAttributes.forEach((attr) => {
      if (config[attr]) { return; }
      throw new TypeError(`Instance requires ${attr}`);
    });
  }


  /**
   * @param {{ clusterName: string, sgId: string, subnetId: string,
   * pid: string, pr: string }} config
   * @throws {Error}
   */
  function validateCreatePrConfig(config) {
    if (!config) {
      throw new TypeError('This function requires a configuration object');
    }
    prConfigAttributes.forEach((attr) => {
      if (config[attr]) { return; }
      throw new TypeError(`Instance requires ${attr}`);
    });
  }

  /**
   * @param {string} subnetId
   * @param {string} sgId
   * @returns {{DeviceIndex: number, AssociatePublicIpAddress: boolean,
    SubnetId: *, DeleteOnTermination: boolean, Groups: Array}}
   */
  function getNICConfig(subnetId, sgId) {
    return {
        DeviceIndex: 0,
        AssociatePublicIpAddress: true,
        SubnetId: subnetId,
        DeleteOnTermination: true,
        Groups: [sgId]
      };
  }

  /**
   * @param {{ clusterName: string, sgId: string, subnetId: string,
   * pid: string, pr: string, auth: Object=, apiConfig: Object=,
   * sshPath: string|string[] }} config
   * config will merge with default ec2 config
   */
  function createPr(config) {
    validateCreatePrConfig(config);
    const clusterName = config.clusterName;
    const auth = config.auth;
    const apiConfig = config.apiConfig;
    const sshPath = config.sshPath;

    return getECSContainerInstanceUserData(clusterName, auth, sshPath).
    then((data) => {
      apiConfig.UserData = data;

      const defaultConfig = util.clone(DEFAULT_INSTANCE_PARAMS);
      const params = R.merge(defaultConfig, apiConfig);

      params.NetworkInterfaces.push(getNICConfig(config.subnetId, config.sgId));

      return ec2.runInstances(params).then((results) => {
        let tagPromises = [];
        let readyPromises = [];
        results.Instances.forEach(function(instance) {
          tagPromises.push(tagPrInstance(instance, config.pr, config.pid));
          readyPromises.push(waitForReady(instance.InstanceId));
        });
        return Q.all(tagPromises.concat(readyPromises)).then(() => {
          return describePr(config.pid, config.pr);
        });
      });
    });
  }

  /**
   * @param {{ clusterName: string, sgId: string, subnetId: string,
   * pid: string, deployment: string, auth: Object=,
   * apiConfig: Object=, sshPath: string|string[] }} config
   * config will merge with default ec2 config
   */
  function createDeployment(config) {
    validateCreateDeploymentConfig(config);
    const clusterName = config.clusterName;
    const auth = config.auth;
    const apiConfig = config.apiConfig;
    const sshPath = config.sshPath;

      //apiConfig.InstanceType = 't2.small';

    return getECSContainerInstanceUserData(clusterName, auth, sshPath).
    then((data) => {
      apiConfig.UserData = data;

      const defaultConfig = util.clone(DEFAULT_INSTANCE_PARAMS);
      const params = R.merge(defaultConfig, apiConfig);

      params.NetworkInterfaces.push(getNICConfig(config.subnetId, config.sgId));

      return ec2.runInstances(params).then((results) => {
        const tagPromises = [];
        const readyPromises = [];
        results.Instances.forEach(function(instance) {
          tagPromises.push(tagDeploymentInstance(
            instance, config.deployment,config.pid
          ));
          readyPromises.push(waitForReady(instance.InstanceId));
        });
        return Q.all(tagPromises.concat(readyPromises)).then(() => {
          return describeDeployment(config.pid, config.deployment);
        });
      });
    });
  }

  /**
   @param {string[]} instanceIds
   */
  function waitForTermination(instanceIds) {
    const fn = makeTerminatedPredicate(instanceIds);

    return util.waitFor(fn, awsConstants.AWS_EC2_POLL_INTERVAL,
      awsConstants.AWS_EC2_POLL_MAX);
  }

  /**
   @param {string[]} instanceIds
   */
  function stopAndTerminate(instanceIds) {
    return ec2.stopInstances({
      InstanceIds: instanceIds
    }).then(() => {
      return ec2.terminateInstances({
        InstanceIds: instanceIds
      });
    }).then(() => {
      return waitForTermination(instanceIds);
    });
  }

  /**
   * @param {string} pid
   * @param {string} pr
   * @returns {Promise}
   */
  function destroyPr(pid, pr) {
    if (!pid || !pr) {
      throw new TypeError('ec2 destroy requires pid, and pr');
    }

    return describePr(pid, pr).then((list) => {
      if (!list.length) {
        common.throwInvalidPidPrTag(pid, pr, 'looking', 'Instance');
      }

      return stopAndTerminate(list[0].Instances.map((el) => {
        return el.InstanceId;
      }));
    });
  }

  /**
   * @param {string} pid
   * @param {string} deployment
   * @returns {Promise}
   */
  function destroyDeployment(pid, deployment) {
    if (!pid || !deployment) {
      throw new TypeError('ec2 destroy requires pid, and pr');
    }

    return describeDeployment(pid, deployment).then((list) => {
      if (!list.length) {
        common.throwInvalidPidDeploymentTag(
          pid, deployment, 'looking', 'Instance'
        );
      }

      return stopAndTerminate(list[0].Instances.map((el) => {
        return el.InstanceId;
      }));
    });
  }

  return {
    createPr,
    createDeployment,
    describe,
    describeProject,
    describePr,
    describeDeployment,
    destroyPr,
    destroyDeployment,
    checkInstanceStatuses,
    helpers: {
      checkInstanceStatuses,
      getECSContainerInstanceUserData,
      loadUserPublicKeys,
      makeDockerAuth,
      makeDockerAuthCfg,
      makeReadyPredicate,
      makeSSHUserData,
      makeTerminatedPredicate,
      processSSHKeys,
      stringArrayToNewLineBase64,
      SETUP_SSH,
      CHOWN_SSH,
      OUTPUT_SSH
    }
  };
}

getEC2Manager.makeSSHUserData = makeSSHUserData;


module.exports = getEC2Manager;
