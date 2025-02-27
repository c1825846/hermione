'use strict';

const _ = require('lodash');
const {EventEmitter} = require('events');
const pluginsLoader = require('plugins-loader');
const Promise = require('bluebird');
const proxyquire = require('proxyquire').noCallThru();

const Config = require('src/config');
const RuntimeConfig = require('src/config/runtime-config');
const AsyncEmitter = require('src/events/async-emitter');
const eventsUtils = require('src/events/utils');
const Errors = require('src/errors');
const RunnerStats = require('src/stats');
const TestReader = require('src/test-reader');
const TestCollection = require('src/test-collection').default;
const RunnerEvents = require('src/constants/runner-events');
const signalHandler = require('src/signal-handler');
const Runner = require('src/runner');
const logger = require('src/utils/logger');
const {makeConfigStub} = require('../utils');

describe('hermione', () => {
    const sandbox = sinon.sandbox.create();
    let Hermione, initReporters;

    const mkHermione_ = (config) => {
        Config.create.returns(config || makeConfigStub());
        return Hermione.create();
    };

    const mkRunnerStub_ = (runFn) => {
        const runner = new AsyncEmitter();

        runner.run = sandbox.stub(Runner.prototype, 'run').callsFake(runFn && runFn.bind(null, runner));
        runner.addTestToRun = sandbox.stub(Runner.prototype, 'addTestToRun');
        runner.init = sandbox.stub(Runner.prototype, 'init').named('RunnerInit');

        sandbox.stub(Runner, 'create').returns(runner);
        return runner;
    };

    beforeEach(() => {
        sandbox.stub(logger, 'warn');
        sandbox.stub(Config, 'create').returns(makeConfigStub());
        sandbox.stub(pluginsLoader, 'load').returns([]);
        sandbox.stub(RuntimeConfig, 'getInstance').returns({extend: sandbox.stub()});
        sandbox.stub(TestReader.prototype, 'read').resolves();
        sandbox.stub(RunnerStats, 'create');

        initReporters = sandbox.stub().resolves();

        Hermione = proxyquire('src/hermione', {
            './reporters': {initReporters}
        });
    });

    afterEach(() => sandbox.restore());

    describe('constructor', () => {
        beforeEach(() => {
            sandbox.stub(Runner, 'create').returns(new EventEmitter());
        });

        it('should create a config from the passed path', () => {
            Hermione.create('some-config-path.js');

            assert.calledOnceWith(Config.create, 'some-config-path.js');
        });

        it('should load plugins', () => {
            Hermione.create();

            assert.calledOnce(pluginsLoader.load);
        });

        it('should load plugins for hermione instance', () => {
            Hermione.create();

            assert.calledWith(pluginsLoader.load, sinon.match.instanceOf(Hermione));
        });

        it('should load plugins from config', () => {
            Config.create.returns(makeConfigStub({plugins: {'some-plugin': true}}));

            Hermione.create();

            assert.calledWith(pluginsLoader.load, sinon.match.any, {'some-plugin': true});
        });

        it('should load plugins with appropriate prefix', () => {
            Hermione.create();

            assert.calledWith(pluginsLoader.load, sinon.match.any, sinon.match.any, 'hermione-');
        });
    });

    describe('extendCli', () => {
        it ('should emit CLI event with passed parser', () => {
            const hermione = mkHermione_();
            const onCli = sinon.spy().named('onCli');
            const parser = {foo: 'bar'};

            hermione.on(RunnerEvents.CLI, onCli);

            hermione.extendCli(parser);

            assert.calledOnceWith(onCli, parser);
        });
    });

    describe('run', () => {
        const runHermione = (paths, opts) => mkHermione_().run(paths, opts);

        beforeEach(() => {
            sandbox.stub(TestCollection.prototype, 'getBrowsers').returns([]);
            sandbox.stub(Hermione.prototype, 'halt');
        });

        it('should create runner', () => {
            mkRunnerStub_();

            return runHermione()
                .then(() => assert.calledOnce(Runner.create));
        });

        it('should create runner with config', () => {
            mkRunnerStub_();

            const config = makeConfigStub();
            Config.create.returns(config);

            return mkHermione_(config)
                .run(() => assert.calledWith(Runner.create, config));
        });

        it('should create runner with interceptors', async () => {
            mkRunnerStub_();

            const hermione = mkHermione_();
            const fooHandler = () => {};
            const barHandler = () => {};

            hermione
                .intercept('foo', fooHandler)
                .intercept('bar', barHandler);

            await hermione.run();

            assert.calledWith(Runner.create, sinon.match.any, [
                {event: 'foo', handler: fooHandler},
                {event: 'bar', handler: barHandler}
            ]);
        });

        it('should warn about unknown browsers from cli', () => {
            mkRunnerStub_();

            return runHermione([], {browsers: ['bro3']})
                .then(() => assert.calledWithMatch(logger.warn, /Unknown browser ids: bro3/));
        });

        it('should init runtime config', () => {
            mkRunnerStub_();

            return runHermione([], {updateRefs: true, requireModules: ['foo'], inspectMode: {inspect: true}})
                .then(() => {
                    assert.calledOnce(RuntimeConfig.getInstance);
                    assert.calledOnceWith(
                        RuntimeConfig.getInstance.lastCall.returnValue.extend,
                        {updateRefs: true, requireModules: ['foo'], inspectMode: {inspect: true}}
                    );
                    assert.callOrder(
                        RuntimeConfig.getInstance,
                        Runner.create
                    );
                });
        });

        describe('INIT', () => {
            beforeEach(() => mkRunnerStub_());

            it('should emit INIT on run', () => {
                const onInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, onInit);

                return hermione.run()
                    .then(() => assert.calledOnce(onInit));
            });

            it('should reject on INIT handler fail', () => {
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, () => Promise.reject('o.O'));

                return assert.isRejected(hermione.run(), /o.O/);
            });

            it('should wait INIT handler before running tests', () => {
                const afterInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, () => Promise.delay(20).then(afterInit));

                return hermione.run()
                    .then(() => assert.callOrder(afterInit, Runner.prototype.run));
            });

            it('should init runner after emit INIT', () => {
                const onInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, onInit);

                return hermione.run()
                    .then(() => assert.callOrder(onInit, Runner.prototype.init));
            });

            it('should send INIT event only once', () => {
                const onInit = sinon.spy().named('onInit');
                const hermione = mkHermione_();
                hermione.on(RunnerEvents.INIT, onInit);

                return hermione.run()
                    .then(() => hermione.run())
                    .then(() => assert.calledOnce(onInit));
            });
        });

        describe('reporters', () => {
            let runner;

            beforeEach(() => {
                runner = mkRunnerStub_();
            });

            it('should initialize passed reporters', async () => {
                const options = {reporters: ['reporter']};
                Config.create.returns(makeConfigStub());
                const hermione = Hermione.create();

                await hermione.run(null, options);

                assert.calledOnceWith(initReporters, ['reporter'], hermione);
            });

            it('should initialize reporters before run tests', async () => {
                const options = {reporters: ['reporter']};
                Config.create.returns(makeConfigStub());
                const hermione = Hermione.create();

                await hermione.run(null, options);

                assert.callOrder(initReporters, runner.run);
            });
        });

        describe('reading the tests', () => {
            beforeEach(() => mkRunnerStub_());

            it('should read tests', async () => {
                const testPaths = ['foo/bar'];
                const browsers = ['bro1', 'bro2'];
                const grep = 'baz.*';
                const sets = ['set1', 'set2'];

                sandbox.spy(Hermione.prototype, 'readTests');

                await runHermione(testPaths, {browsers, grep, sets});

                assert.calledOnceWith(Hermione.prototype.readTests, testPaths, {browsers, grep, sets});
            });

            it('should accept test collection as first parameter', async () => {
                const testCollection = Object.create(TestCollection.prototype);

                await runHermione(testCollection);

                assert.calledOnceWith(Runner.prototype.run, testCollection);
            });

            it('should not read tests if test collection passed instead of paths', async () => {
                const testCollection = Object.create(TestCollection.prototype);
                sandbox.spy(Hermione.prototype, 'readTests');

                await runHermione(testCollection);

                assert.notCalled(Hermione.prototype.readTests);
            });
        });

        describe('running of tests', () => {
            it('should run tests', () => {
                mkRunnerStub_();

                return runHermione()
                    .then(() => assert.calledOnce(Runner.prototype.run));
            });

            it('should use read tests', async () => {
                mkRunnerStub_();

                const testCollection = TestCollection.create();
                sandbox.stub(Hermione.prototype, 'readTests').resolves(testCollection);

                await runHermione();

                assert.calledWith(Runner.prototype.run, testCollection);
            });

            it('should create runner stats', async () => {
                mkRunnerStub_();

                const hermione = mkHermione_();

                await hermione.run();

                assert.calledOnceWith(RunnerStats.create, hermione);
            });

            it('should use created runner stats ', async () => {
                mkRunnerStub_();

                RunnerStats.create.returns('foo bar');

                await runHermione();

                assert.calledWith(Runner.prototype.run, sinon.match.any, 'foo bar');
            });

            it('should return "true" if there are no failed tests', () => {
                mkRunnerStub_();

                return runHermione()
                    .then((success) => assert.isTrue(success));
            });

            it('should return "false" if there are failed tests', () => {
                mkRunnerStub_((runner) => runner.emit(RunnerEvents.TEST_FAIL));

                return runHermione()
                    .then((success) => assert.isFalse(success));
            }) ;

            it('should halt if there were some errors', () => {
                const hermione = mkHermione_();
                const err = new Error();

                mkRunnerStub_((runner) => runner.emit(RunnerEvents.ERROR, err));

                return hermione.run()
                    .then(() => assert.calledOnceWith(hermione.halt, err));
            });
        });

        describe('should passthrough', () => {
            it('all synchronous runner events', () => {
                const runner = mkRunnerStub_();
                const hermione = mkHermione_();

                return hermione.run()
                    .then(() => {
                        _.forEach(RunnerEvents.getSync(), (event, name) => {
                            const spy = sinon.spy().named(`${name} handler`);
                            hermione.on(event, spy);

                            runner.emit(event);

                            assert.calledOnce(spy);
                        });
                    });
            });

            it('synchronous runner events before "Runner.run" called', () => {
                sandbox.stub(eventsUtils, 'passthroughEvent');
                const runner = mkRunnerStub_();
                const hermione = mkHermione_();

                return hermione.run()
                    .then(() => {
                        assert.calledWith(eventsUtils.passthroughEvent,
                            runner,
                            sinon.match.instanceOf(Hermione),
                            _.values(RunnerEvents.getSync())
                        );
                        assert.callOrder(eventsUtils.passthroughEvent, runner.run);
                    });
            });

            it('all asynchronous runner events', () => {
                const runner = mkRunnerStub_();
                const hermione = mkHermione_();

                return hermione.run()
                    .then(() => {
                        _.forEach(RunnerEvents.getAsync(), (event, name) => {
                            const spy = sinon.spy().named(`${name} handler`);
                            hermione.on(event, spy);

                            runner.emitAndWait(event);

                            assert.calledOnce(spy);
                        });
                    });
            });

            it('asynchronous runner events before "Runner.run" called', () => {
                sandbox.stub(eventsUtils, 'passthroughEventAsync');
                const runner = mkRunnerStub_();
                const hermione = mkHermione_();

                return hermione.run()
                    .then(() => {
                        assert.calledWith(eventsUtils.passthroughEventAsync,
                            runner,
                            sinon.match.instanceOf(Hermione),
                            _.values(RunnerEvents.getAsync())
                        );
                        assert.callOrder(eventsUtils.passthroughEventAsync, runner.run);
                    });
            });

            it('all runner events with passed event data', () => {
                const runner = mkRunnerStub_();
                const hermione = mkHermione_();
                const omitEvents = ['EXIT', 'NEW_BROWSER', 'UPDATE_REFERENCE'];

                return hermione.run()
                    .then(() => {
                        _.forEach(_.omit(hermione.events, omitEvents), (event, name) => {
                            const spy = sinon.spy().named(`${name} handler`);
                            hermione.on(event, spy);

                            runner.emit(event, 'some-data');

                            assert.calledWith(spy, 'some-data');
                        });
                    });
            });

            it('exit event from signalHandler', () => {
                mkRunnerStub_();

                const hermione = mkHermione_();
                const onExit = sinon.spy().named('onExit');

                return hermione.run()
                    .then(() => {
                        hermione.on('exit', onExit);

                        signalHandler.emitAndWait('exit');

                        assert.calledOnce(onExit);
                    });
            });

            it('exit event before "Runner.run" called', () => {
                sandbox.stub(eventsUtils, 'passthroughEventAsync');

                const runner = mkRunnerStub_();
                const hermione = mkHermione_();

                return hermione.run()
                    .then(() => {
                        assert.calledWith(eventsUtils.passthroughEventAsync,
                            sinon.match.instanceOf(AsyncEmitter),
                            sinon.match.instanceOf(Hermione),
                            RunnerEvents.EXIT
                        );
                        assert.callOrder(eventsUtils.passthroughEventAsync, runner.run);
                    });
            });
        });
    });

    describe('addTestToRun', () => {
        it('should pass test to the existing runner', async () => {
            const runner = mkRunnerStub_();
            const hermione = mkHermione_();
            const test = {};

            await hermione.run();
            hermione.addTestToRun(test, 'bro');

            assert.calledOnceWith(runner.addTestToRun, test, 'bro');
        });

        it('should return false when hermione is not running', () => {
            const runner = mkRunnerStub_();
            const hermione = mkHermione_();

            const added = hermione.addTestToRun({});

            assert.isFalse(added);
            assert.notCalled(runner.addTestToRun);
        });
    });

    describe('readTests', () => {
        beforeEach(() => {
            sandbox.spy(TestReader, 'create');

            sandbox.stub(TestCollection, 'create').returns(Object.create(TestCollection.prototype));
            sandbox.stub(TestCollection.prototype, 'sortTests');
            sandbox.stub(TestCollection.prototype, 'getBrowsers').returns([]);
        });

        it('should create test reader', async () => {
            const config = makeConfigStub();

            const hermione = mkHermione_(config);

            await hermione.readTests();

            assert.calledOnceWith(TestReader.create, config);
        });

        [
            'BEFORE_FILE_READ',
            'AFTER_FILE_READ'
        ].forEach((event) => {
            it(`should passthrough ${event} event from test reader`, async () => {
                const eventHandler = sandbox.stub();
                const hermione = mkHermione_()
                    .on(RunnerEvents[event], eventHandler);

                TestReader.prototype.read.callsFake(function() {
                    this.emit(RunnerEvents[event], {foo: 'bar'});
                });

                await hermione.readTests();

                assert.calledOnceWith(eventHandler, {foo: 'bar'});
            });

            it(`should not passthrough ${event} event from test reader with silent option`, async () => {
                const eventHandler = sandbox.stub();
                const hermione = mkHermione_()
                    .on(RunnerEvents[event], eventHandler);

                TestReader.prototype.read.callsFake(function() {
                    this.emit(RunnerEvents[event]);
                });

                await hermione.readTests(null, {silent: true});

                assert.notCalled(eventHandler);
            });
        });

        it('should read passed test files', async () => {
            const hermione = mkHermione_();

            await hermione.readTests(
                ['foo/bar'],
                {
                    browsers: ['bro'],
                    ignore: 'baz/qux',
                    sets: ['s1', 's2'],
                    grep: 'grep'
                }
            );

            assert.calledOnceWith(TestReader.prototype.read, {
                paths: ['foo/bar'],
                browsers: ['bro'],
                ignore: 'baz/qux',
                sets: ['s1', 's2'],
                grep: 'grep'
            });
        });

        it('should return TestCollection', async () => {
            const tests = {someBro: ['test', 'otherTest']};

            TestReader.prototype.read.returns(tests);
            const testCollection = TestCollection.create();
            TestCollection.create.withArgs(tests).returns(testCollection);

            const hermione = mkHermione_();
            const result = await hermione.readTests();

            assert.equal(result, testCollection);
        });

        it('should sort tests if corresponding config option set', async () => {
            const browsers = ['foo', 'bar'];
            const config = makeConfigStub({browsers});
            config.forBrowser('bar').strictTestsOrder = true;

            const hermione = mkHermione_(config);
            TestCollection.prototype.getBrowsers.returns(browsers);

            await hermione.readTests();

            assert.calledOnceWith(TestCollection.prototype.sortTests, 'bar', sinon.match.func);
        });

        it('should sort tests by id', async () => {
            const browsers = ['foo'];
            const config = makeConfigStub({browsers});
            config.forBrowser('foo').strictTestsOrder = true;

            const hermione = mkHermione_(config);
            TestCollection.prototype.getBrowsers.returns(browsers);

            await hermione.readTests();
            const sortFn = TestCollection.prototype.sortTests.firstCall.args[1];

            assert.equal(sortFn({id: 'a'}, {id: 'b'}), -1);
            assert.equal(sortFn({id: 'a'}, {id: 'a'}), 1);
            assert.equal(sortFn({id: 'b'}, {id: 'a'}), 1);
        });

        describe('INIT', () => {
            it('should emit INIT on read', async () => {
                const onInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, onInit);

                await hermione.readTests();

                assert.calledOnce(onInit);
            });

            it('should reject on INIT handler fail', () => {
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, () => Promise.reject('o.O'));

                return assert.isRejected(hermione.readTests(), /o.O/);
            });

            it('should wait INIT handler before reading tests', async () => {
                const afterInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, () => Promise.delay(20).then(afterInit));

                await hermione.readTests();

                assert.callOrder(afterInit, TestReader.prototype.read);
            });

            it('should not emit INIT on silent read', async () => {
                const onInit = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.INIT, onInit);

                await hermione.readTests(null, {silent: true});

                assert.notCalled(onInit);
            });

            it('should send INIT event only once', async () => {
                const onInit = sinon.spy();
                const hermione = mkHermione_();
                hermione.on(RunnerEvents.INIT, onInit);

                await hermione.readTests();
                await hermione.readTests();

                assert.calledOnce(onInit);
            });
        });

        describe('AFTER_TESTS_READ', () => {
            it('should emit AFTER_TESTS_READ on read', async () => {
                const onAfterTestsRead = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.AFTER_TESTS_READ, onAfterTestsRead);

                await hermione.readTests();

                assert.calledOnce(onAfterTestsRead);
            });

            it('should pass test collection with AFTER_TESTS_READ event', async () => {
                const onAfterTestsRead = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.AFTER_TESTS_READ, onAfterTestsRead);

                const collection = await hermione.readTests();

                assert.calledWith(onAfterTestsRead, collection);
            });

            it('should not emit AFTER_TESTS_READ in silent mode', async () => {
                const onAfterTestsRead = sinon.spy();
                const hermione = mkHermione_()
                    .on(RunnerEvents.AFTER_TESTS_READ, onAfterTestsRead);

                await hermione.readTests(null, {silent: true});

                assert.notCalled(onAfterTestsRead);
            });
        });
    });

    describe('should provide access to', () => {
        it('hermione events', () => {
            const expectedEvents = _.extend(
                {NEW_BROWSER: 'newBrowser', UPDATE_REFERENCE: 'updateReference'},
                RunnerEvents
            );

            assert.deepEqual(mkHermione_().events, expectedEvents);
        });

        it('hermione configuration', () => {
            const config = {foo: 'bar'};

            assert.deepEqual(mkHermione_(config).config, config);
        });

        it('hermione errors', () => {
            assert.deepEqual(mkHermione_().errors, Errors);
        });
    });

    describe('isFailed', () => {
        it('should return "false" by default', () => {
            assert.isFalse(mkHermione_().isFailed());
        });

        it('should return "false" if there are no failed tests or errors', () => {
            mkRunnerStub_();

            const hermione = mkHermione_();

            return hermione.run()
                .then(() => assert.isFalse(hermione.isFailed()));
        });

        it('should return "true" after some test fail', () => {
            const hermione = mkHermione_();

            mkRunnerStub_((runner) => {
                runner.emit(RunnerEvents.TEST_FAIL);

                assert.isTrue(hermione.isFailed());
            });

            return hermione.run();
        });
    });

    describe('isWorker', () => {
        it('should return "false"', () => {
            const hermione = mkHermione_();

            assert.isFalse(hermione.isWorker());
        });
    });

    describe('halt', () => {
        let hermione;

        beforeEach(() => {
            hermione = mkHermione_();

            sandbox.stub(logger, 'error');
            sandbox.stub(process, 'exit');
            sandbox.stub(Runner.prototype, 'run').callsFake(() => hermione.emitAndWait(RunnerEvents.RUNNER_START));
            sandbox.stub(Runner.prototype, 'cancel');
        });

        it('should log provided error', () => {
            hermione.on(RunnerEvents.RUNNER_START, () => {
                hermione.halt(new Error('test error'));
            });

            return hermione.run()
                .finally(() => {
                    assert.calledOnceWith(logger.error, sinon.match(/Error: test error/));
                });
        });

        it('should cancel test runner', () => {
            hermione.on(RunnerEvents.RUNNER_START, () => {
                hermione.halt(new Error('test error'));
            });

            return hermione.run()
                .finally(() => {
                    assert.calledOnce(Runner.prototype.cancel);
                });
        });

        it('should mark test run as failed', () => {
            hermione.on(RunnerEvents.RUNNER_START, () => {
                hermione.halt(new Error('test error'));
            });

            return hermione.run()
                .finally(() => {
                    assert.isTrue(hermione.isFailed());
                });
        });

        describe('shutdown timeout', () => {
            it('should force exit if timeout is reached', () => {
                hermione.on(RunnerEvents.RUNNER_START, () => {
                    hermione.halt(new Error('test error'), 250);
                });

                return hermione.run()
                    .finally(() => Promise.delay(300))
                    .then(() => {
                        assert.calledWithMatch(logger.error, /Forcing shutdown.../);
                        assert.calledOnceWith(process.exit, 1);
                    });
            });

            it('should do nothing if timeout is set to zero', () => {
                sandbox.spy(global, 'setTimeout');
                hermione.on(RunnerEvents.RUNNER_START, () => {
                    hermione.halt(new Error('test error'), 0);
                });

                return hermione.run()
                    .finally(() => {
                        assert.notCalled(global.setTimeout);
                    });
            });
        });
    });
});
