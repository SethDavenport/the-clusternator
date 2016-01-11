'use strict';

const SSH_PUBLIC = 'ssh-public';
const MAX_PROJECT_NAME = 150;

const aws = require('../../../aws/project-init');
const path = require('path');
const util = require('../../../util');
const dockernate = require('../../../dockernate');
const slack = require('../../../cli-wrappers/slack');
const clusternatorJson = require('../../../clusternator-json');
const config = require('../../../config')();
const constants = require('../../../constants');
const ec2 = require('../../../aws/ec2Manager');
const Projects = require('../../../server/db/projects');
const Q = require('q');

const API = constants.DEFAULT_API_VERSION;

var projects;

function noopP() {
  return Q.resolve(true);
}

function getPFail(res) {
  return (err) => {
    res.status(500).json({ error: err.message });
  };
}

/**
 * @param {string} repo fully qualified repo URI/path
 * @param {string} imageName
 * @param {boolean=} noSlack if === true then noSlack output
 * @returns {Q.Promise}
 */
function projectBuild(repo, imageName, noSlack) {
  return dockernate
    .create(repo, imageName)
    .then(() => {
      if (noSlack === true) { return; }
      return slack.message(`Built New Image: ${imageName}`,
        'the-clusternator');
    }).fail((err) => {
      if (noSlack === true) { return; }
      return slack.message(`Build Image ${imageName} failed, Error:
              ${err}`, 'the-clusternator');
    });
}

function sanitizePr(pr) {
  pr = +pr;
  return pr !== pr ? 0 : pr;
}

function sanitizeSha(sha) {
  if (!sha) {
    sha = '';
  }
  sha = sha + '';
  return sha.length > 5 && sha.length <= 40 ? sha : 'master';
}

/**
 * @param {{id: string, repo: string}} project
 * @param {string} pr
 * @param {string} sha
 * @param {function(...):Q.Promise} middleware
 * @returns {Q.Promise}
 */
function prCreateDocker(project, pr, sha, middleware) {
  const image = `${config.dockerRegistryPrefix}${project.id}:${pr}`;
  return dockernate.create(
    project.backend, project.repo, image, sha, middleware)
    .then(() => {
      return image;
    }, (err) => {
      throw err;
    }, (update) => {
      if (!update) {
        util.info('prCreateDocker: unexpected lack of data');
        return;
      }
      if (update.error) {
        console.log(update.error);
      }
    });
}

function makePrCreate(pm) {
  return (body) => {
    var pr = sanitizePr(body.pr),
      appDef = JSON.parse(body.appDef),
      projectId = body.repo,
      sshData = body.sshData,
      useInternalSSL = body.useInternalSSL || false;

    console.log('DEBUG');
    console.log(JSON.stringify(body,  null, 2));
    console.log('DEBUG');

    return projects.find(projectId).then((project) => {
      return pm.pr.create(projectId, pr + '', appDef, sshData, useInternalSSL)
        .then((prResult) => {
          return slack.message(`Create: ${projectId}, PR ${pr} ` +
            `successful.  Application will be available at ` +
            `<http://${prResult.url}>`,
            project.channel);
        })
        .fail((err) => {
          slack.message(`Create: ${projectId}, PR ${pr} ` +
            `failed: ${err.message}`, project.channel);
          throw err;
        });
    });
  };
}

/**
 * @param {ProjectManager} pm
 * @returns {Function(Object)}
 */
function makePrCreateFull(pm) {
  return (body) => {
    var pr = sanitizePr(body.pr),
      sha = sanitizeSha(body.sha),
      appDef, sshData;

    return projects
      .find(body.id)
      .then((project) => {
        return prCreateDocker(project, pr, sha, (desc) => {
          /**
           * This anonymous function passed to prCreateDocker
           * is middleware, and is not part of the surrounding promise chain
           */
          util.info('Collecting deployment data from repo in ', desc.path);
          return clusternatorJson
            .readPrivate(project.sharedKey, desc.path)
            .then(() => {
              util.info(`Reading clusternator.json from ${desc.path}`);
              return clusternatorJson.getFrom(desc.path);
            })
            .then((srcConfig) => {
              const defPath =
                path.join(desc.path, srcConfig.deploymentsDir, 'pr');
              util.info(`Collecting application definition(s)`);
              appDef = require(defPath );
            })
            .then(() => {
              return ec2
                .makeSSHUserData(path.join(desc.path, '.private', SSH_PUBLIC))
                .then((userData) => {
                  util.info('Collected SSH Public Keys');
                  sshData = userData;
                });
            });
        }).then((image) => {
          appDef.tasks[0].containerDefinitions[0].environment[0].value =
            project.sharedKey;
          appDef.tasks[0].containerDefinitions[0].image = image;
          util.info('Launching PR With Appdef:');
          util.info(JSON.stringify(appDef, null, 2));
          return pm.createPR(project.id, pr + '', appDef, sshData);
        }).then((prResult) => {
          return slack.message(`Create: ${body.id}, PR ${pr}, SHA ${sha} ` +
            `successful.  Application will be available at ` +
            `<http://${prResult.url}>`,
            project.channel);
        }).fail((err) => {
          slack.message(`Create: ${body.id}, PR ${pr}, SHA ${sha} ` +
            `failed: ${err.message}`, project.channel);
          throw err;
        });
      })
      .fail((err) => {
        util.error('Commands: Failed to create PR: ', err.message, err.stack);
        return slack.message(`Create: ${body.id}, PR ${pr}, SHA ${sha}
        failed: ${err.message}`, 'the-clusternator');
      });
  };
}

/**
 * @param {ProjectManager} pm
 * @returns {Function(Object)}
 */
function makePrDestroy(pm) {
  return (body) => {
    var pr = sanitizePr(body.pr);
    return projects
      .find(body.id)
      .then((project) => {
        return pm.destroyPR(project.id, pr + '');
      });
  };
}

function listProjects(req, res, next) {
  projects.list().then((projectIds) => {
    if (req.get('ContentType') === 'application/json') {
      res.json(projects);
    } else {
      res.render('projects', { api: API, projects: projectIds });
    }
  }, getPFail(res));
}

function validateBackend(be) {
  var index = projects.BACKENDS.indexOf(be);
  if (index === -1) {
    return projects.BACKENDS[0];
  }
  return projects.BACKENDS[1];
}

function setProject(req, res, next) {
  projects.find(req.params.project).then((p) => {
    p.name = req.body.name;
    p.sharedKey = req.body.sharedKey;
    p.repoToken = req.body.repoToken;
    p.channel = req.body.channel;
    p.backend = validateBackend(req.body.backend);
    return projects
      .setItem(p.id, p)
      .then(() => {
        res.json(p);
      });
  }, () => {
    res.status(404).json({ error: 'Not Found'});
  }).fail(getPFail(res));
}

function getProject(req, res, next) {
  projects.find(req.params.project).then((project) => {
    if (req.get('ContentType') === 'application/json') {
      res.json({
        id: project.id,
        name: project.name,
        sharedKey: project.sharedKey,
        channel: project.channel
      });
    } else {
      res.render('project', {
        api: API, project: project, backends: projects.BACKENDS
      });
    }
  }, () => {
    res.status(404).json({ error: 'Not Found'});
  }).fail(getPFail(res));
}

function getCommands(credentials) {

  return aws(credentials)
    .then((pm) => {
      projects = Projects(config, pm);
      return projects
        .init
        .then(() => pm);
    })
    .then((pm) => {
      return {
        projects: {
          create: pm.create,
          list: listProjects,
          getProject: getProject,
          setProject: setProject,
          describe: noopP,
          destroy: pm.destroy,
          build: (body) => {
            console.log('BODY', body);
            console.log('figure this out');
            //projectBuild();
          }
        },
        pr: {
          create: (body) => {
            makePrCreate(pm)(body);
            return Q.resolve();
          },
          list: noopP,
          describe: noopP,
          destroy: makePrDestroy(pm)
        },
        deployment: {
          create: pm.createDeployment,
          list: noopP,
          describe: noopP,
          destroy: pm.destroyDeployment
        }
      };
    });
}

module.exports = getCommands;