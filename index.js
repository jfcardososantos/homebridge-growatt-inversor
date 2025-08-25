const axios = require('axios');

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  console.log('[Growatt] Plugin carregando...');
  
  const { hap } = homebridge;
  const Characteristic = hap.Characteristic;
  const Service = hap.Service;

  // Registra como plataforma dinâmica
  homebridge.registerPlatform('homebridge-growatt-inversor', 'GrowattInversor', GrowattPlatform, true);
  
  console.log('[Growatt] Plugin registrado com sucesso!');
};

// ==================================================================================
//  PLATFORM CLASS
// ==================================================================================

class GrowattPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    
    this.token = this.config.token;
    this.refreshInterval = (this.config.refreshInterval || 5) * 60 * 1000;

    this.log.info('=== GROWATT PLATFORM INICIANDO ===');
    
    if (!this.token) {
      this.log.error('❌ ERRO: Token não configurado!');
      return;
    }

    this.log.info(`🔑 Token configurado: ${this.token.substring(0, 10)}...`);

    // Aguarda o Homebridge terminar de carregar
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('🚀 Homebridge carregou, iniciando descoberta...');
        setTimeout(() => {
          this.discoverDevices();
        }, 2000);
      });
    }
  }

  // Restaura acessórios do cache
  configureAccessory(accessory) {
    this.log.info(`🔧 Restaurando do cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('🔍 === BUSCANDO INVERSORES ===');

    try {
      this.log.info(`📡 Fazendo chamada para API...`);
      
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 
          'token': this.token
        },
        timeout: 20000
      });

      this.log.info(`✅ Resposta recebida: ${JSON.stringify(response.data)}`);

      if (response.data.error_code !== 0) {
        throw new Error(`Erro da API: ${response.data.error_msg}`);
      }

      const plants = response.data.data?.plants || [];
      this.log.info(`📊 Encontrados ${plants.length} inversor(es)`);

      if (plants.length === 0) {
        this.log.warn('⚠️ Nenhum inversor encontrado na sua conta');
        return;
      }

      // Remove acessórios antigos
      if (this.accessories.length > 0) {
        this.log.info('🗑️ Removendo acessórios antigos...');
        this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', this.accessories);
        this.accessories = [];
      }

      // Cria acessórios
      for (const plant of plants) {
        this.log.info(`➕ Criando acessório para: ${plant.name} (ID: ${plant.plant_id})`);
        
        const uuid = this.api.hap.uuid.generate(`growatt-${plant.plant_id}`);
        const accessory = new this.api.platformAccessory(plant.name || `Inversor ${plant.plant_id}`, uuid);
        
        // Salva dados no contexto
        accessory.context.plantId = plant.plant_id;
        accessory.context.name = plant.name;
        accessory.context.token = this.token;
        accessory.context.refreshInterval = this.refreshInterval;
        
        // Configura serviços
        this.setupAccessoryServices(accessory);
        
        this.accessories.push(accessory);
      }

      // Registra no HomeKit
      if (this.accessories.length > 0) {
        this.log.info(`🏠 Registrando ${this.accessories.length} acessório(s) no HomeKit...`);
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', this.accessories);
        
        // Inicia monitoramento
        this.accessories.forEach(accessory => {
          this.startMonitoring(accessory);
        });
      }

    } catch (error) {
      this.log.error('❌ ERRO ao descobrir dispositivos:');
      this.log.error(`Erro: ${error.message}`);
      if (error.response) {
        this.log.error(`Status: ${error.response.status}`);
        this.log.error(`Data: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  setupAccessoryServices(accessory) {
    const name = accessory.context.name;
    
    // Serviço de informação
    const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation) ||
                       accessory.addService(this.api.hap.Service.AccessoryInformation);
    
    infoService
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(this.api.hap.Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, accessory.context.plantId.toString());

    // Sensor de potência (Light Sensor)
    const powerService = accessory.getService('Potencia') ||
                        accessory.addService(this.api.hap.Service.LightSensor, 'Potencia', 'power');
    
    powerService.getCharacteristic(this.api.hap.Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0, maxValue: 100000 });

    // Sensor de energia hoje (Humidity)
    const todayService = accessory.getService('Energia Hoje') ||
                        accessory.addService(this.api.hap.Service.HumiditySensor, 'Energia Hoje', 'today');
    
    todayService.getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100 });

    // Sensor de status (Contact)
    const statusService = accessory.getService('Status') ||
                         accessory.addService(this.api.hap.Service.ContactSensor, 'Status', 'status');

    this.log.info(`✅ Serviços configurados para: ${name}`);
  }

  startMonitoring(accessory) {
    const plantId = accessory.context.plantId;
    const token = accessory.context.token;
    const interval = accessory.context.refreshInterval;
    
    this.log.info(`⏰ Iniciando monitoramento: ${accessory.displayName}`);

    const updateData = async () => {
      try {
        const response = await axios.get(`https://openapi.growatt.com/v1/plant/data?plant_id=${plantId}`, {
          headers: { 'token': token },
          timeout: 15000
        });

        if (response.data.error_code === 0) {
          const data = response.data.data;
          
          const currentPower = parseFloat(data.current_power) || 0;
          const todayEnergy = parseFloat(data.today_energy) || 0;
          const isOnline = currentPower > 0;

          // Atualiza sensores
          const powerService = accessory.getService('Potencia');
          const todayService = accessory.getService('Energia Hoje');
          const statusService = accessory.getService('Status');

          if (powerService) {
            powerService.updateCharacteristic(this.api.hap.Characteristic.CurrentAmbientLightLevel, currentPower);
          }
          
          if (todayService) {
            todayService.updateCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, Math.min(todayEnergy, 100));
          }
          
          if (statusService) {
            statusService.updateCharacteristic(this.api.hap.Characteristic.ContactSensorState, 
              isOnline ? this.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED : 
                        this.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
          }

          this.log.info(`📊 ${accessory.displayName}: ${currentPower}W, Hoje: ${todayEnergy}kWh, ${isOnline ? 'Online' : 'Offline'}`);
        }
      } catch (error) {
        this.log.error(`❌ Erro ao atualizar ${accessory.displayName}: ${error.message}`);
      }
    };

    // Primeira atualização em 5 segundos
    setTimeout(updateData, 5000);
    
    // Atualização periódica
    setInterval(updateData, interval);
  }
}