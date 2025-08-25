const axios = require('axios');

let Service, Characteristic, PlatformAccessory, generateUUID;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  PlatformAccessory = homebridge.platformAccessory;
  generateUUID = homebridge.hap.uuid.generate;

  homebridge.registerPlatform('homebridge-growatt-inversor', 'GrowattInversor', GrowattPlatform, false);
};

// ==================================================================================
//  PLATFORM CLASS
// ==================================================================================

class GrowattPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    
    this.token = this.config.token;
    this.refreshInterval = (this.config.refreshInterval || 5) * 60 * 1000;

    if (!this.token) {
      this.log.error('❌ Token não configurado na plataforma! O plugin não irá iniciar.');
      return;
    }

    this.log.info('*** Plataforma Growatt Solar Iniciando ***');

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('🚀 Homebridge carregado. Iniciando descoberta de inversores...');
        this.initialDiscovery();
      });
    }
  }

  configureAccessory(accessory) {
    if (accessory.context.plantId) {
      this.log.info(`🔄 Restaurando inversor do cache: ${accessory.displayName} (Plant ID: ${accessory.context.plantId})`);
      this.accessories.set(accessory.context.plantId.toString(), accessory);
    } else {
      this.log.warn(`👻 Ignorando acessório do cache sem Plant ID: ${accessory.displayName}`);
    }
  }

  async initialDiscovery() {
    this.log.info('🔍 Buscando inversores na sua conta Growatt...');

    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 'token': this.token },
        timeout: 15000
      });

      if (response.data.error_code !== 0) {
        throw new Error(`Erro da API Growatt: ${response.data.error_msg || 'Erro desconhecido'}`);
      }

      const plants = response.data.data?.plants || [];
      if (plants.length === 0) {
        this.log.warn('⚠️ Nenhum inversor (planta) encontrado na sua conta.');
        return;
      }

      this.log.info(`📡 Descobertos ${plants.length} inversor(es).`);

      const plantData = plants.map(plant => ({
        plantId: plant.plant_id,
        plantName: plant.name || `Inversor ${plant.plant_id}`,
        city: plant.city || 'Não informado',
        peakPower: plant.peak_power || 0,
      }));

      for (const plant of plantData) {
        const plantId = plant.plantId.toString();
        const plantName = plant.plantName;
        const uuid = generateUUID(`growatt-inversor-${plantId}`);
        
        let accessory = this.accessories.get(plantId);

        if (accessory) {
          this.log.info(`✅ Inversor existente encontrado no cache: "${plantName}".`);
          accessory.displayName = plantName;
          accessory.context.plantName = plantName;
          accessory.context.city = plant.city;
          accessory.context.peakPower = plant.peakPower;
        } else {
          this.log.info(`➕ Adicionando novo inversor: "${plantName}" (Plant ID: ${plantId})`);
          accessory = new PlatformAccessory(plantName, uuid);
          accessory.context.plantId = plantId;
          accessory.context.plantName = plantName;
          accessory.context.city = plant.city;
          accessory.context.peakPower = plant.peakPower;
          
          this.accessories.set(plantId, accessory);
          this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
        }

        this.setupAccessoryServices(accessory);
        this.log.info(`🔧 "${plantName}" configurado com sucesso.`);
      }

      this.log.info('✅ Descoberta inicial finalizada.');
      this.startPeriodicMonitoring(plantData);

    } catch (error) {
      this.log.error(`❌ ERRO CRÍTICO na descoberta inicial: ${error.message}`);
      this.log.warn('⏳ Tentando novamente em 5 minutos...');
      setTimeout(() => this.initialDiscovery(), 5 * 60 * 1000);
    }
  }

  setupAccessoryServices(accessory) {
    const name = accessory.context.plantName;
    this.log.info(`🔧 Configurando serviços para "${name}"...`);

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.plantId)
      .setCharacteristic(Characteristic.FirmwareRevision, '2.0.0');

    const getOrCreateService = (serviceType, displayName, subtype) => {
      let service = accessory.getServiceById(serviceType, subtype);
      if (!service) {
        service = accessory.addService(serviceType, displayName, subtype);
      }
      return service;
    };

    // Sensores de Luz para exibir dados numéricos
    getOrCreateService(Service.LightSensor, 'Produção Hoje', 'today_energy');
    getOrCreateService(Service.LightSensor, 'Produção Atual', 'current_power');
    getOrCreateService(Service.LightSensor, 'Produção no Mês', 'month_energy');
    getOrCreateService(Service.LightSensor, 'Produção Total', 'total_energy');

    // Switch para indicar status de produção
    const switchService = getOrCreateService(Service.Switch, 'Produzindo', 'producing_status');
    switchService.getCharacteristic(Characteristic.On).onGet(() => accessory.context.isProducing || false);

    this.log.info(`✅ Serviços para "${name}" configurados.`);
  }

  startPeriodicMonitoring(plantData) {
    this.log.info(`⏰ Iniciando monitoramento periódico para ${plantData.length} inversor(es)...`);

    const updateAllData = async () => {
      this.log.info('🔄 Atualizando dados de todos os inversores...');

      for (const plant of plantData) {
        const plantId = plant.plantId.toString();
        const accessory = this.accessories.get(plantId);
        if (!accessory) continue;

        try {
          const response = await axios.get(`https://openapi.growatt.com/v1/plant/data?plant_id=${plantId}`, {
            headers: { 'token': this.token },
            timeout: 10000
          });

          if (response.data.error_code === 0 && response.data.data) {
            const data = response.data.data;
            const currentPower = parseFloat(data.current_power) || 0;
            const todayEnergy = parseFloat(data.today_energy) || 0;
            const monthEnergy = parseFloat(data.month_energy) || 0;
            const totalEnergy = parseFloat(data.total_energy) || 0;
            const isProducing = currentPower > 0.1;

            accessory.context.isProducing = isProducing;

            accessory.getServiceById(Service.LightSensor, 'today_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, todayEnergy);
            accessory.getServiceById(Service.LightSensor, 'current_power')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, currentPower);
            accessory.getServiceById(Service.LightSensor, 'month_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, monthEnergy);
            accessory.getServiceById(Service.LightSensor, 'total_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, totalEnergy);
            accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, isProducing);

            const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
            this.log.info(`⚡ ${accessory.displayName}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Mês: ${monthEnergy.toFixed(2)}kWh | ${status}`);
          } else {
            this.log.warn(`⚠️ Não foi possível obter dados para "${accessory.displayName}". API: ${response.data.error_msg || 'Erro desconhecido'}`);
            this.setAccessoryOffline(accessory);
          }
        } catch (error) {
          this.log.error(`❌ Erro ao contatar API para "${accessory.displayName}": ${error.message}`);
          this.setAccessoryOffline(accessory);
        }
      }
    };

    updateAllData();
    setInterval(updateAllData, this.refreshInterval);
    this.log.info(`✅ Monitoramento iniciado. Atualizações a cada ${this.refreshInterval / 60000} minutos.`);
  }

  setAccessoryOffline(accessory) {
    this.log.warn(`🔌 Colocando "${accessory.displayName}" em modo offline.`);
    accessory.context.isProducing = false;
    accessory.getServiceById(Service.LightSensor, 'today_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0);
    accessory.getServiceById(Service.LightSensor, 'current_power')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0);
    accessory.getServiceById(Service.LightSensor, 'month_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0);
    accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, false);
  }
}