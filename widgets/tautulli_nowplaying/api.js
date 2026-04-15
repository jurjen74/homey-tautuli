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
  async getNowPlaying({ homey, query }) {
    const deviceId = query.deviceId || null;
    const device = findDevice(homey, deviceId);
    if (!device) throw new Error('No Tautulli device found');
    return device.getNowPlaying();
  },
};
