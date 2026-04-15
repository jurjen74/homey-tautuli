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
  async getTopStats({ homey, query }) {
    const deviceId = query.deviceId || null;
    const timeRange = Math.max(1, parseInt(query.timeRange, 10) || 30);
    const count = Math.max(3, Math.min(10, parseInt(query.count, 10) || 5));

    const device = findDevice(homey, deviceId);
    if (!device) throw new Error('No Tautulli device found');

    return device.getTopStats({ timeRange, count });
  },
};
