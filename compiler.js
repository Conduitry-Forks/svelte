const worker_threads = require('node:worker_threads');

if (worker_threads.isMainThread) {
	// We are in the main thread, so we want to define the synchronous function that will wrap the asynchronous one.
	// Each worker has a MessageChannel (a pair of MessagePorts) automatically created for it, but in the main thread we only have access to it via an .on() method on the worker, which is asynchronous.
	// In order to synchronously read the response from the worker, we need to create our own MessageChannel.
	// We can still use the default global MessagePort to send requests into the worker.

	// Create the SharedArrayBuffer that the worker will use to notify the main thread that it has sent a response.
	const buffer = new SharedArrayBuffer(4);
	// Create the MessageChannel that the worker will use to send its responses back to the main thread.
	const message_channel = new worker_threads.MessageChannel();
	// Create a worker from this file, and pass it the SharedArrayBuffer and MessagePort as worker data.
	const worker = new worker_threads.Worker(__filename, {
		workerData: { buffer, port: message_channel.port1 },
		transferList: [message_channel.port1]
	});
	worker.unref();
	// Create the TypedArray that the Atomics API needs.
	const array = new Int32Array(buffer);

	// The synchronous function that wraps the asynchronous function.
	const run = (outgoing_message) => {
		// Pass the worker a message containing the arguments we want to call the asynchronous function with.
		worker.postMessage(outgoing_message);
		// Sleep until the worker thread notifies us that it is complete.
		Atomics.wait(array, 0, 0);
		// Synchronously read the response from the worker thread.
		const { message } = worker_threads.receiveMessageOnPort(message_channel.port2);
		if (message.error) {
			throw Object.assign(message.value, message.extra_fields);
		}
		return message.value;
	};

	exports.VERSION = require('./package.json').version;

	exports.compile = (...args) => {
		const response = run({ cmd: 'compile', args });
		const warning_strings = response._warning_strings;
		delete response._warning_strings;
		for (let i = 0; i < response.warnings.length; i++) {
			response.warnings[i].toString = () => warning_strings[i];
		}
		return response;
	};

	exports.parse = (...args) => {
		return run({ cmd: 'parse', args });
	};

	exports.preprocess = (...args) => import('./compiler.mjs').then((m) => m.preprocess(...args));

	// exports.walk = walk;
} else {
	// We are in the worker thread.

	// Create the TypedArray that the Atomics API needs.
	const array = new Int32Array(worker_threads.workerData.buffer);
	// Listen for a message containing the passed-in args.
	worker_threads.parentPort.on('message', async ({ cmd, args }) => {
		let message;
		try {
			const compiler = await import('./compiler.mjs');
			let result;
			if (cmd === 'compile') {
				result = compiler.compile(...args);
				result._warning_strings = [];
				for (let i = 0; i < result.warnings.length; i++) {
					result._warning_strings[i] = result.warnings[i].toString();
					delete result.warnings[i].toString;
				}
			} else if (cmd === 'parse') {
				result = compiler.parse(...args);
			}
			message = { error: false, value: result };
		} catch (error) {
			message = { error: true, value: error, extra_fields: { ...error } };
		}
		// Post the response to the MessagePort of the MessageChannel created by the main thread.
		worker_threads.workerData.port.postMessage(message);
		// Notify the main thread that we've sent it a response.
		Atomics.notify(array, 0);
	});
}
