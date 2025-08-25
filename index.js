const axios = require('axios');

let hap, Characteristic, Service;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  hap = homebridge.hap;
  Characteristic = hap.Characteristic;
  Service = hap.Service;

  // Registra o plugin como plataforma para suportar múltiplos acessórios
  homebridge.registerPlatform('homebridge-growatt-inversor', 'GrowattInversor', GrowattPlatform);
};

// ==================================================================================
//  PLATFORM CLASS - Gerencia múltiplos inversores
// ==================================================================================

class GrowattPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.token = config.token;
    this.refreshInterval = (config.refreshInterval || 5) * 60 * 1000;
    this.accessories = [];

    if (!this.token) {
      this.log.error('❌ Token da API não configurado. Verifique suas configurações.');
      return;
    }

    this.log.info('🌞 Inicializando Growatt Platform');
    this.log.info(`🔑 Token: ${this.token.substring(0, 10)}...`);

    if (api) {
      this.api.on('didFinishLaunching', () => {
        this.discoverDevices();
      });
    }
  }

  /**
   * Busca todos os inversores da conta
   */
  async discoverDevices() {
    this.log.info('🔍 Buscando inversores na conta...');

    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 
          'token': this.token,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      this.log.debug('📡 Resposta plant/list:', JSON.stringify(response.data));

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg} (Code: ${response.data.error_code})`);
      }

      const plants = response.data.data?.plants || [];
      this.log.info(`📊 Encontrados ${plants.length} inversor(es)`);

      // Remove acessórios antigos
      this.accessories.forEach(accessory => {
        this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
      });
      this.accessories = [];

      // Cria um acessório para cada inversor
      plants.forEach(plant => {
        this.log.info(`➕ Adicionando inversor: ${plant.name} (ID: ${plant.plant_id})`);
        
        const uuid = this.api.hap.uuid.generate(`growatt-${plant.plant_id}`);
        const accessory = new this.api.platformAccessory(plant.name, uuid);
        
        // Adiciona informações do inversor ao contexto
        accessory.context.plantId = plant.plant_id;
        accessory.context.name = plant.name;
        accessory.context.city = plant.city;
        accessory.context.country = plant.country;
        accessory.context.peakPower = plant.peak_power;
        
        // Configura o acessório
        new GrowattInversorAccessory(this.log, accessory, this.token, this.refreshInterval);
        
        this.accessories.push(accessory);
      });

      // Registra todos os acessórios
      if (this.accessories.length > 0) {
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', this.accessories);
      }

    } catch (error) {
      this.log.error('❌ Erro ao buscar inversores:');
      if (error.response) {
        this.log.error(`- Status HTTP: ${error.response.status}`);
        this.log.error(`- Dados: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log.error(`- Erro: ${error.message}`);
      }
    }
  }

  configureAccessory(accessory) {
    this.log.info(`🔧 Configurando acessório: ${accessory.displayName}`);
    this.accessories.push(accessory);
    
    // Reconfigura o acessório com as configurações atuais
    new GrowattInversorAccessory(this.log, accessory, this.token, this.refreshInterval);
  }
}

// ==================================================================================
//  ACCESSORY CLASS - Cada inversor individual
// ==================================================================================

class GrowattInversorAccessory {
  constructor(log, accessory, token, refreshInterval) {
    this.log = log;
    this.accessory = accessory;
    this.token = token;
    this.refreshInterval = refreshInterval;
    
    // Dados do inversor
    this.plantId = accessory.context.plantId;
    this.name = accessory.context.name;
    this.city = accessory.context.city || 'Desconhecida';
    this.country = accessory.context.country || 'Brasil';
    this.peakPower = accessory.context.peakPower || 0;

    // Estado do inversor
    this.state = {
      currentPower: 0,
      todayEnergy: 0,
      totalEnergy: 0,
      monthlyEnergy: 0,
      yearlyEnergy: 0,
      lastUpdate: '',
      status: false
    };

    this.log.info(`🚀 Configurando inversor: ${this.name} (${this.city})`);
    this.setupServices();
    this.startPeriodicUpdates();
  }

  /**
   * Configura os serviços HomeKit
   */
  setupServices() {
    // 1. Serviço de Informação
    const infoService = this.accessory.getService(Service.AccessoryInformation) ||
                       this.accessory.addService(Service.AccessoryInformation);
    
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, `Inversor Solar ${this.peakPower}W`)
      .setCharacteristic(Characteristic.SerialNumber, this.plantId.toString())
      .setCharacteristic(Characteristic.FirmwareRevision, '1.1.0')
      .setCharacteristic(Characteristic.Name, this.name);

    // 2. Sensor de Potência (Light Sensor)
    this.powerService = this.accessory.getService(`${this.name} Potencia`) ||
                       this.accessory.addService(Service.LightSensor, `${this.name} Potencia`, 'power');
    
    this.powerService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0, maxValue: 100000, minStep: 1 })
      .onGet(() => this.state.currentPower);

    // 3. Sensor de Energia Hoje (Humidity Sensor)
    this.todayService = this.accessory.getService(`${this.name} Hoje`) ||
                       this.accessory.addService(Service.HumiditySensor, `${this.name} Hoje`, 'today');
    
    this.todayService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(() => Math.min(this.state.todayEnergy, 100));

    // 4. Sensor de Status (Contact Sensor)
    this.statusService = this.accessory.getService(`${this.name} Status`) ||
                        this.accessory.addService(Service.ContactSensor, `${this.name} Status`, 'status');
    
    this.statusService
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.state.status ? 
        Characteristic.ContactSensorState.CONTACT_DETECTED : 
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

    // 5. Sensor de Energia Total (outro Light Sensor)
    this.totalService = this.accessory.getService(`${this.name} Total`) ||
                       this.accessory.addService(Service.LightSensor, `${this.name} Total`, 'total');
    
    this.totalService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0, maxValue: 999999, minStep: 0.1 })
      .onGet(() => this.state.totalEnergy);

    this.log.info(`✅ Serviços configurados para: ${this.name}`);
  }

  /**
   * Inicia atualizações periódicas
   */
  startPeriodicUpdates() {
    // Primeira atualização em 3 segundos
    setTimeout(() => this.updateData(), 3000);
    
    // Atualizações periódicas
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    this.updateTimer = setInterval(() => this.updateData(), this.refreshInterval);
    this.log.info(`⏰ Atualizações configuradas para ${this.name} (${this.refreshInterval / 60000}min)`);
  }

  /**
   * Busca dados da API e atualiza sensores
   */
  async updateData() {
    this.log.debug(`🔄 Atualizando dados: ${this.name}`);

    try {
      const url = `https://openapi.growatt.com/v1/plant/data?plant_id=${this.plantId}`;
      
      const response = await axios.get(url, {
        headers: { 
          'token': this.token,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg} (Code: ${response.data.error_code})`);
      }

      const data = response.data.data;
      if (!data) {
        throw new Error('Dados não encontrados na resposta');
      }

      // Atualiza estado
      this.state.currentPower = parseFloat(data.current_power) || 0;
      this.state.todayEnergy = parseFloat(data.today_energy) || 0;
      this.state.totalEnergy = parseFloat(data.total_energy) || 0;
      this.state.monthlyEnergy = parseFloat(data.monthly_energy) || 0;
      this.state.yearlyEnergy = parseFloat(data.yearly_energy) || 0;
      this.state.lastUpdate = data.last_update_time || '';
      this.state.status = this.state.currentPower > 0;

      // Atualiza características
      this.powerService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, this.state.currentPower);
      this.todayService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Math.min(this.state.todayEnergy, 100));
      this.statusService.updateCharacteristic(Characteristic.ContactSensorState, 
        this.state.status ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
      this.totalService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, this.state.totalEnergy);

      this.log.info(`✅ ${this.name}: ${this.state.currentPower}W, Hoje: ${this.state.todayEnergy}kWh, Total: ${this.state.totalEnergy}kWh, ${this.state.status ? 'Online' : 'Offline'}`);

    } catch (error) {
      this.log.error(`❌ Erro ao atualizar ${this.name}:`);
      if (error.response) {
        this.log.error(`- Status: ${error.response.status}, Dados: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log.error(`- ${error.message}`);
      }

      // Marca como offline
      this.state.status = false;
      this.statusService.updateCharacteristic(Characteristic.ContactSensorState, 
        Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }
}