import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import {
  collectEndTrackingEvents,
  collectStartTrackingEvent,
  createTrackingRunContext,
  formatTrackingTime,
  markTrackingRunStarted,
  markTrackingTaskLoaded,
  taskSettingsTrackingEvent,
  TrackingClient
} from '../dist/runtime/tracking.js';

function decryptTrackingPayload(data) {
  const keyBuffer = Buffer.alloc(16);
  keyBuffer.write('Octopus1');
  const decipher = createDecipheriv('aes-128-ecb', keyBuffer, null);
  return JSON.parse(decipher.update(data, 'base64', 'utf8') + decipher.final('utf8'));
}

test('tracking upload uses overseas endpoint and encrypted CLI payload', async () => {
  const originalUrl = process.env.OCTOPARSE_TRACKING_URL;
  const originalDisabled = process.env.OCTOPARSE_TRACKING_DISABLED;
  process.env.OCTOPARSE_TRACKING_URL = 'https://tracking.example';
  delete process.env.OCTOPARSE_TRACKING_DISABLED;

  const requests = [];
  const client = new TrackingClient({ userId: 'user-1', authSource: 'env' }, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  });

  client.send({
    time: '2026-05-18 08:00:00.000000+08:00',
    name: 'TrackCollectStart',
    content: { taskId: 'task-1', taskFile: '' }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://tracking.example/extract/upload');
    const body = JSON.parse(requests[0].init.body);
    const payload = decryptTrackingPayload(body.data);
    assert.equal(payload.product, 'octoparse-cli');
    assert.equal(payload.channel, 'cli');
    assert.equal(payload.common.userId, 'user-1');
    assert.equal(payload.common.keySource, 'env');
    assert.match(payload.common.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/);
    assert.equal(payload.events[0].name, 'TrackCollectStart');
    assert.equal(payload.events[0].content.taskFile, '');
  } finally {
    if (originalUrl === undefined) delete process.env.OCTOPARSE_TRACKING_URL;
    else process.env.OCTOPARSE_TRACKING_URL = originalUrl;
    if (originalDisabled === undefined) delete process.env.OCTOPARSE_TRACKING_DISABLED;
    else process.env.OCTOPARSE_TRACKING_DISABLED = originalDisabled;
  }
});

test('tracking event content stays close to desktop extraction events plus taskFile', () => {
  const runOptions = {
    taskId: 'task-1',
    taskFile: 'task.json',
    outputDir: '/tmp/out',
    headless: false,
    json: false,
    jsonl: false,
    disableImage: false,
    disableAD: false,
    runTimeoutMs: 1000,
    extensionTimeoutMs: 1000,
    debugBridge: false,
    detach: false
  };
  const task = {
    taskId: 'task-1',
    taskName: 'Task',
    xml: '<Workflow useKernelBrowser="true" />',
    xoml: '',
    fieldNames: [],
    workFlowType: 10,
    isTemplate: true,
    brokerSettings: {
      ipProxySettings: { ipProxyFromType: 0 },
      userAgentSwitchSettings: { switchType: 0 },
      cookieClearSettings: { clearType: 0 }
    }
  };
  const context = createTrackingRunContext({ taskId: 'task-1', runOptions, billingWarningCount: 0 });
  markTrackingTaskLoaded(context, task);
  markTrackingRunStarted(context, {
    runId: 'run-1',
    lotId: 'lot-1',
    taskId: 'task-1',
    taskName: 'Task'
  });

  const start = collectStartTrackingEvent(context, true);
  assert.deepEqual(Object.keys(start.content).sort(), [
    'collectType',
    'entrance',
    'fail_reason',
    'newCreate',
    'speed',
    'startWay',
    'success',
    'taskFile',
    'taskId',
    'taskType',
    'timeSpend'
  ].sort());

  const settings = taskSettingsTrackingEvent(context, task);
  assert.deepEqual(Object.keys(settings.content).sort(), [
    'lotNo',
    'subTaskId',
    'taskFile',
    'taskId',
    'taskSettings'
  ].sort());
  assert.deepEqual(Object.keys(settings.content.taskSettings).sort(), [
    'cookie',
    'ipProxy',
    'isJson',
    'isSpeedMode',
    'runnerType',
    'taskName',
    'taskType',
    'userAgent'
  ].sort());

  const endEvents = collectEndTrackingEvents(context, {
    status: 'completed',
    endWay: 'finish',
    success: true,
    total: 3,
    useCaptchaCount: 1,
    useProxyCount: 2
  });
  assert.deepEqual(endEvents.map((event) => event.name), [
    'TrackCollectEnd',
    'CollectHistory',
    'TaskExecutionResult'
  ]);
  for (const event of [start, settings, ...endEvents]) {
    assert.match(event.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/);
  }
  assert.match(String(endEvents[1].content.collectStart), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/);
  assert.match(String(endEvents[1].content.collectEnd), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/);
  assert.equal(endEvents[1].content.taskFile, 'task.json');
  assert.equal(endEvents[2].content.taskExecutionResult.useCaptchaCount, 1);
  assert.equal(endEvents[2].content.taskExecutionResult.useProxyCount, 2);
});

test('formatTrackingTime uses local timestamp with microseconds and timezone offset', () => {
  const value = formatTrackingTime(new Date('2026-05-18T07:44:06.031Z'));
  assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.031000[+-]\d{2}:\d{2}$/);
});
