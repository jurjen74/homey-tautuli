'use strict';

const Homey = require('homey');

module.exports = class TautuliApp extends Homey.App {

  async onInit() {
    this.log('Tautuli app initialized');
  }

};
