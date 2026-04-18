import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncController } from '../src/lib/editor/sync-controller.ts';

class FakeTimer {
	private now = 0;
	private nextId = 1;
	private scheduled = new Map<number, { dueAt: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number) {
		const id = this.nextId++;
		this.scheduled.set(id, {
			dueAt: this.now + delayMs,
			callback
		});
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>) {
		this.scheduled.delete(handle as unknown as number);
	}

	advanceBy(ms: number) {
		this.now += ms;
		let ranTask = true;
		while (ranTask) {
			ranTask = false;
			for (const [id, task] of [...this.scheduled.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)) {
				if (task.dueAt > this.now) {
					continue;
				}
				this.scheduled.delete(id);
				task.callback();
				ranTask = true;
				break;
			}
		}
	}
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

test('debounced sync runs once from the last meaningful edit', async () => {
	const timer = new FakeTimer();
	const calls: boolean[] = [];
	const controller = createSyncController({
		delayMs: 3000,
		timer,
		runSync: async () => {
			calls.push(true);
		}
	});

	controller.scheduleDebounced();
	timer.advanceBy(2000);
	controller.scheduleDebounced();
	timer.advanceBy(2999);
	await Promise.resolve();
	assert.equal(calls.length, 0);

	timer.advanceBy(1);
	await Promise.resolve();
	assert.equal(calls.length, 1);
});

test('immediate sync clears a pending debounce and runs right away', async () => {
	const timer = new FakeTimer();
	const calls: boolean[] = [];
	const controller = createSyncController({
		delayMs: 3000,
		timer,
		runSync: async () => {
			calls.push(true);
		}
	});

	controller.scheduleDebounced();
	controller.requestImmediate();
	await Promise.resolve();
	assert.equal(calls.length, 1);

	timer.advanceBy(3000);
	await Promise.resolve();
	assert.equal(calls.length, 1);
});

test('immediate sync while busy queues exactly one follow-up sync', async () => {
	const timer = new FakeTimer();
	const firstRun = createDeferred();
	const callOptions: boolean[] = [];
	let runCount = 0;
	const controller = createSyncController({
		delayMs: 3000,
		timer,
		runSync: async (options) => {
			callOptions.push(options.showSuccessNotice);
			runCount += 1;
			if (runCount === 1) {
				await firstRun.promise;
			}
		}
	});

	controller.requestImmediate();
	await Promise.resolve();
	controller.requestImmediate({ showSuccessNotice: true });
	controller.requestImmediate({ showSuccessNotice: false });
	await Promise.resolve();
	assert.equal(callOptions.length, 1);

	firstRun.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(callOptions, [false, true]);
});

test('queued follow-up inherits the strongest success-notice request', async () => {
	const timer = new FakeTimer();
	const firstRun = createDeferred();
	const callOptions: boolean[] = [];
	let runCount = 0;
	const controller = createSyncController({
		delayMs: 3000,
		timer,
		runSync: async (options) => {
			callOptions.push(options.showSuccessNotice);
			runCount += 1;
			if (runCount === 1) {
				await firstRun.promise;
			}
		}
	});

	controller.requestImmediate();
	await Promise.resolve();
	controller.queueFollowUp();
	controller.queueFollowUp({ showSuccessNotice: true });

	firstRun.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(callOptions, [false, true]);
});
