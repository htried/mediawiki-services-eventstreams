'use strict';

const os = require('os');
const _ = require('lodash');
const P = require('bluebird');
const kafkaSse = require('kafka-sse');

const sUtil = require('../lib/util');
const eUtil = require('../lib/eventstreams-util');

const IntervalCounter = eUtil.IntervalCounter;

const HTTPError = sUtil.HTTPError;

/**
 * The main router object
 */
const router = sUtil.router();

/**
 * The main application object reported when this module is require()d
 */
let app;


module.exports = function(appObj) {

    app = appObj;

    // Per-worker metrics will be prefixed with hostname.worker_id
    const workerMetricPrefix = `${os.hostname()}.${app.conf.worker_id}`;
    // Per worker and stream connection metric prefix.
    const streamConnectionMetricPrefix = `${workerMetricPrefix}.connections.stream`;
    const clientConnectionMetricPrefix = `${workerMetricPrefix}.connections.client_ip`;

    // This interval counter will be used to report the number of connected clients
    // per stream for this worker every statistics_interval_ms.
    const intervalCounter = new IntervalCounter(
        app.metrics.timing.bind(app.metrics),
        app.conf.statistics_interval_ms || 60000
    );

    router.get('/stream/:streams', (req, res) => {
        let clientConnectionMetric;
        // ensure the requesting client hasn't gone over the conncurrent connection limits.
        if (app.conf.client_ip_connection_limit) {
            if (!req.headers['x-client-ip']) {
                throw new HTTPError({
                    status: 400,
                    type: 'bad_request',
                    title: 'Missing Required X-Client-IP Header',
                    detail: 'X-Client-IP is a required request header'
                });
            }

            clientConnectionMetric = `${clientConnectionMetricPrefix}.${req.headers['x-client-ip']}`;
            const clientConnectionCount = intervalCounter.get(clientConnectionMetric) || 0;
            if (clientConnectionCount >= app.conf.client_ip_connection_limit) {
                throw new HTTPError({
                    status: 429,
                    type: 'too_many_requests',
                    title: 'Too Many Concurrent Connections From Your Client IP',
                    detail: 'Your HTTP client is likely opening too many concurrent connections.'
                });
            }
        }

        const streams = req.params.streams.split(',');
        // Ensure all requested streams are available.
        const invalidStreams = streams.filter(stream => !(stream in app.conf.streams));
        if (invalidStreams.length > 0) {
            throw new HTTPError({
                status: 400,
                type: 'not_found',
                title: 'Stream Not Found',
                detail: `Invalid streams: ${invalidStreams.join(',')}`
            });
        }

        // Get the list of topics that make up the requested streams.
        const topics = _.flatMap(streams, stream => app.conf.streams[stream].topics);

        // If since param is provided, it will be used to consume from
        // a point in time in the past, if Last-Event-ID doesn't already
        // have assignments in it.
        let atTimestamp = req.query.since;
        // If not a milliseconds timestamp, attempt to parse it into one.
        if (atTimestamp && isNaN(atTimestamp)) {
            atTimestamp = Date.parse(atTimestamp);
        }
        // If atTimestamp is defined but is still not a number milliseconds timestamp,
        // throw HTTPError.
        if (atTimestamp !== undefined && isNaN(atTimestamp)) {
            throw new HTTPError({
                status: 400,
                type: 'invalid_timestamp',
                title: 'Invalid timestamp',
                // eslint-disable-next-line max-len
                detail: `since timestamp is not a UTC milliseconds unix epoch and was not parseable: '${req.query.since}'`
            });
        }

        // Increment the number of current connections for these streams.
        streams.forEach((stream) => {
            // Increment the number of current connections for this stream using this key.
            intervalCounter.increment(`${streamConnectionMetricPrefix}.${stream}`);
        });

        if (clientConnectionMetric) {
            // Increment the number of concurrent connections for configured client headers.
            intervalCounter.increment(clientConnectionMetric);
        }

        // After the connection is closed, decrement the number
        // of current connections for these streams.
        res.on('close', () => {
            app.logger.log('debug/stats', 'Decrementing counters');
            streams.forEach((stream) => {
                intervalCounter.decrement(`${streamConnectionMetricPrefix}.${stream}`);
            });
            if (clientConnectionMetric) {
                // Decrement the number of concurrent connections for this client ip
                intervalCounter.decrement(clientConnectionMetric);
            }
        });

        // If application/json disable SSE formatting so only 
        // JSON messages are sent in body; no SSE formattting is desired.
        let disableSSEFormatting = false;
        const responseHeaders = {};
        if (_.has(req.headers, 'content-type')) {
            responseHeaders['content-type'] = req.headers['content-type'];
            if (responseHeaders['content-type'].startsWith('application/json')) {
                disableSSEFormatting = true;
            }
        }

        // Start the SSE EventStream connection with topics.
        return kafkaSse(req, res, topics,
            {
                // Using topics for allowedTopics may seem redundant, but it
                // prevents requests for /stream/streamA from consuming from topics
                // that are not configured for streamA by setting other topics
                // in the Last-Event-ID header.  Last-Event-ID topic, partition, offset
                // assignments will take precedence over topics parameter.
                allowedTopics:          topics,
                // Support multi DC Kafka clusters by using message timestamps
                // in Last-Event-ID instead of offsets.
                useTimestampForId:      true,
                // Give kafkaSse the request bunyan logger to use.
                logger:                 req.logger._logger,
                kafkaConfig:            app.conf.kafka,
                // Use the eventstreams custom deserializer to include
                // kafka message meta data in the deserialized message.meta object
                // that will be sent to the client as an event.
                deserializer:           eUtil.deserializer,
                headers:                responseHeaders,
                disableSSEFormatting
            },
            atTimestamp
        );
    });

    return {
        path: '/v2',
        api_version: 2,
        skip_domain: true,
        router
    };
};
