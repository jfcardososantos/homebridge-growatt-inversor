const axios = require('axios');

let Service, Characteristic, UUIDGen, PlatformAccessory;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  console.log('[Growatt] Carregando plugin...');
  
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;
  PlatformAccessory = homebridge.platformAccessory;

  homebridge.registerPlatform('homebridge-growatt-inversor', 'GrowattInversor', GrowattPlatform, false);
  console.log('[Growatt] Plugin registrado!');
};

// ==================================================================================
//  PLATFORM CLASS
// ==================================================================================

class GrowattPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cachedAccessories = [];
    
    this.token = this.config.token;
    this.refreshInterval = (this.config.refreshInterval || 5) * 60 * 1000;

    this.log.info('*** GROWATT PLATFORM INICIANDO ***');
    
    if (!this.token) {
      this.log.error('❌ Token não configurado na plataforma!');
      return;
    }

    this.log.info(`🔑 Token: ${this.token.substring(0, 10)}...`);

    this.accessories = new Map();

    // Aguarda carregar completamente
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('🚀 Homebridge carregado - iniciando descoberta...');
        this.discoverDevices();
      });
    }
  }

  // Configurar acessórios já em cache
  configureAccessory(accessory) {
    this.log.info(`🔄 Carregando do cache: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('🔍 Descobrindo inversores...');

    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 'token': this.token },
        timeout: 15000
      });

      this.log.info(`📡 API respondeu: ${JSON.stringify(response.data)}`);

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg}`);
      }

      const plants = response.data.data?.plants || [];
      this.log.info(`📊 ${plants.length} inversor(es) encontrado(s)`);

      // Remove acessórios que não existem mais
      const currentUUIDs = plants.map(plant => UUIDGen.generate(`growatt-${plant.plant_id}`));
      const toRemove = this.cachedAccessories.filter(accessory => !currentUUIDs.includes(accessory.UUID));
      
      if (toRemove.length > 0) {
        this.log.info(`🗑️ Removendo ${toRemove.length} acessório(s) obsoleto(s)`);
        this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', toRemove);
      }

      const toAdd = [];

      for (const plant of plants) {
        const uuid = UUIDGen.generate(`growatt-${plant.plant_id}`);
        let accessory = this.cachedAccessories.find(acc => acc.UUID === uuid);
        
        if (!accessory) {
          this.log.info(`➕ Criando novo acessório: ${plant.name}`);
          accessory = new PlatformAccessory(plant.name || `Inversor ${plant.plant_id}`, uuid);
          toAdd.push(accessory);
        } else {
          this.log.info(`✅ Reutilizando acessório: ${plant.name}`);
        }

        // Configurar contexto
        accessory.context.plantId = plant.plant_id;
        accessory.context.plantName = plant.name || `Inversor ${plant.plant_id}`;
        accessory.context.city = plant.city;
        accessory.context.peakPower = plant.peak_power;

        // Configurar serviços
        this.configureAccessoryServices(accessory);
        
        // Iniciar monitoramento
        this.startMonitoring(accessory);
        
        this.accessories.set(uuid, accessory);
      }

      // Registrar novos acessórios
      if (toAdd.length > 0) {
        this.log.info(`🏠 Registrando ${toAdd.length} novo(s) acessório(s)`);
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', toAdd);
      }

      this.log.info(`✅ ${plants.length} inversor(es) configurado(s) com sucesso!`);

    } catch (error) {
      this.log.error('❌ ERRO na descoberta:');
      this.log.error(`Mensagem: ${error.message}`);
      
      if (error.response) {
        this.log.error(`Status: ${error.response.status}`);
        this.log.error(`Data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  configureAccessoryServices(accessory) {
    const name = accessory.context.plantName;
    
    // Serviço de informação
    let infoService = accessory.getService(Service.AccessoryInformation);
    if (!infoService) {
      infoService = accessory.addService(Service.AccessoryInformation);
    }
    
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.plantId.toString())
      .setCharacteristic(Characteristic.FirmwareRevision, '1.1.1');

    // Sensor de potência (Light Sensor)
    let powerService = accessory.getService('Potencia');
    if (!powerService) {
      powerService = accessory.addService(Service.LightSensor, 'Potencia', 'power');
    }
    
    powerService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ 
        minValue: 0, 
        maxValue: 100000,
        minStep: 1 
      });

    // Sensor de energia hoje (Humidity)
    let todayService = accessory.getService('Energia Hoje');
    if (!todayService) {
      todayService = accessory.addService(Service.HumiditySensor, 'Energia Hoje', 'today');
    }
    
    todayService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({ 
        minValue: 0, 
        maxValue: 100,
        minStep: 0.1 
      });

    // Sensor de status (Contact)
    let statusService = accessory.getService('Status');
    if (!statusService) {
      statusService = accessory.addService(Service.ContactSensor, 'Status', 'status');
    }

    this.log.info(`🔧 Serviços configurados para: ${name}`);
  }

  startMonitoring(accessory) {
    const plantId = accessory.context.plantId;
    const name = accessory.context.plantName;
    
    // Limpar timer existente se houver
    if (accessory.updateTimer) {
      clearInterval(accessory.updateTimer);
    }

    this.log.info(`⏰ Iniciando monitoramento: ${name}`);

    const updateData = async () => {
      try {
        const response = await axios.get(`https://openapi.growatt.com/v1/plant/data?plant_id=${plantId}`, {
          headers: { 'token': this.token },
          timeout: 10000
        });

        if (response.data.error_code === 0 && response.data.data) {
          const data = response.data.data;
          
          const currentPower = parseFloat(data.current_power) || 0;
          const todayEnergy = parseFloat(data.today_energy) || 0;
          const totalEnergy = parseFloat(data.total_energy) || 0;
          const isOnline = currentPower > 0;

          // Atualizar sensores
          const powerService = accessory.getService('Potencia');
          if (powerService) {
            powerService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, currentPower);
          }
          
          const todayService = accessory.getService('Energia Hoje');
          if (todayService) {
            todayService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, Math.min(todayEnergy, 100));
          }
          
          const statusService = accessory.getService('Status');
          if (statusService) {
            statusService.updateCharacteristic(
              Characteristic.ContactSensorState, 
              isOnline ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            );
          }

          this.log.info(`📊 ${name}: ${currentPower}W | Hoje: ${todayEnergy}kWh | Total: ${totalEnergy}kWh | ${isOnline ? 'Online' : 'Offline'}`);
        } else {
          this.log.warn(`⚠️ ${name}: Dados inválidos recebidos da API`);
        }
      } catch (error) {
        this.log.error(`❌ ${name}: Erro ao atualizar - ${error.message}`);
      }
    };

    // Primeira atualização em 3 segundos
    setTimeout(updateData, 3000);
    
    // Atualização periódica
    accessory.updateTimer = setInterval(updateData, this.refreshInterval);
  }

  // Cleanup quando removido
  removeAccessory(accessory) {
    if (accessory.updateTimer) {
      clearInterval(accessory.updateTimer);
    }
    this.accessories.delete(accessory.UUID);
  }
}