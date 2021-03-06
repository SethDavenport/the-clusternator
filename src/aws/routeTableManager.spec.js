'use strict';

const rewire = require('rewire');
const Q = require('q');
const constants = require('../constants');
const common = require('./common');
const ec2Mock = require('./ec2-mock');

const RouteTable = rewire('./routeTableManager');
const C = require('../chai');


/*global describe, it, expect, beforeEach, afterEach */
describe('routeTableManager success cases', () => {
  let routeTable;
  let oldDesc;

  beforeEach(() => {
    oldDesc = common.makeEc2DescribeFn;
    common.makeEc2DescribeFn = () => {
      return () => {
        return Q.resolve([{
          Tags: [{
            Key: constants.CLUSTERNATOR_TAG,
            Value: 'true'
          }]
        }]);
      };
    };
    RouteTable.__set__('common', common);
    routeTable = RouteTable(ec2Mock, 'vpc-id');
  });

  afterEach(() => {
    common.makeEc2DescribeFn = oldDesc;
    RouteTable.__set__('common', common);
  });

  it('should asynchronously list routeTables', (done) => {
    routeTable.describe().then((list) => {
      C.check(done, () => {
        expect(list).to.be.ok;
      });
    }, C.getFail(done));
  });


  it('findDefault should resolve if a clusternator tag is not found',
    (done) => {
      routeTable.findDefault().then(function() {
        C.check(done, () => {
          expect(true).to.be;
        });
      }, C.getFail(done));
    });
});

describe('routeTableManager fail cases', () => {
  let routeTable;
  let oldDesc;

  beforeEach(() => {
    oldDesc = common.makeEc2DescribeFn;
    common.makeEc2DescribeFn = () => {
      return () => {
        return Q.reject(new Error('test'));
      };
    };
    RouteTable.__set__('common', common);
    routeTable = RouteTable(ec2Mock, 'vpc-id');
  });

  afterEach(() => {
    common.makeEc2DescribeFn = oldDesc;
    RouteTable.__set__('common', common);
  });

  it('should reject its promise on fail', (done) => {
    routeTable.describe().then(C.getFail(done), (err) => {
      C.check(done, () => {
        expect(err instanceof Error).to.be.true;
      });
    });
  });

  it('findDefault should reject if a clusternator tag is not found', (done) => {
    routeTable.findDefault().then(C.getFail(done), (err) => {
      C.check(done, () => {
        expect(err instanceof Error).to.be.true;
      });
    });
  });
});
