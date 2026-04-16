'use strict';

const Homey = require('homey');
const TautulliClient = require('../../lib/TautulliClient');

class TautulliDriver extends Homey.Driver {

  async onInit() {
    // --- Triggers ---

    this._streamStartedTrigger = this.homey.flow.getDeviceTriggerCard('stream_started');
    this._streamEndedTrigger = this.homey.flow.getDeviceTriggerCard('stream_ended');
    this._streamPausedTrigger = this.homey.flow.getDeviceTriggerCard('stream_paused');
    this._streamResumedTrigger = this.homey.flow.getDeviceTriggerCard('stream_resumed');
    this._watchCompletedTrigger = this.homey.flow.getDeviceTriggerCard('watch_completed');

    this._activeStreamsChangedTrigger = this.homey.flow.getDeviceTriggerCard('active_streams_changed');

    // --- Conditions ---

    this.homey.flow.getConditionCard('stream_count_above')
      .registerRunListener(async (args) => {
        const count = await args.device.getCapabilityValue('measure_streams');
        return (count ?? 0) > args.count;
      });

    this.log('TautulliDriver initialized');
  }

  async onPair(session) {
    let pendingDevice = null;

    session.setHandler('test_connection', async ({ host: rawHost, apiKey: rawKey }) => {
      const url = rawHost.trim().replace(/\/$/, '');
      const apiKey = rawKey.trim();

      if (!url) throw new Error(this.homey.__('pair.connect.error_host_required'));
      if (!apiKey) throw new Error(this.homey.__('pair.connect.error_apikey_required'));

      const client = new TautulliClient(url, apiKey);
      await client.testConnection();

      pendingDevice = {
        name: `Tautulli (${new URL(url).hostname})`,
        data: { id: url },
        settings: { url, apiKey, pollInterval: 15 },
      };

      return {};
    });

    session.setHandler('list_devices', async () => {
      return pendingDevice ? [pendingDevice] : [];
    });
  }

}

module.exports = TautulliDriver;
