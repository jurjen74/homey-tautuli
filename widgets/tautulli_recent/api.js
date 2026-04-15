'use strict';

function findDevice(homey, deviceId) {
  try {
    const devices = homey.drivers.getDriver('tautulli').getDevices();
    if (deviceId) {
      return devices.find((d) => d.getId() === deviceId) || null;
    }
    return devices.length ? devices[0] : null;
  } catch {
    return null;
  }
}

module.exports = {
  async getHistory({ homey, query }) {
    const count = Math.max(1, Math.min(25, parseInt(query.count, 10) || 10));
    const deviceId = query.deviceId || null;

    const device = findDevice(homey, deviceId);
    if (!device) throw new Error('No Tautulli device found');

    return device.getRecentHistory(count);
  },
};
