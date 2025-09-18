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
      this.log.info(`🔌 Restaurando acessório do cache: ${accessory.displayName}`);
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
      }

      this.log.info(`📡 API da Growatt retornou ${plants.length} inversor(es).`);

      const plantData = plants.map(plant => ({
        plantId: plant.plant_id,
        plantName: plant.name || `Inversor ${plant.plant_id}`,
        city: plant.city || 'Não informado',
        peakPower: plant.peak_power || 0,
      }));

      const activePlantIds = new Set(plantData.map(p => p.plantId.toString()));

      // Remover acessórios que não estão mais na conta Growatt
      for (const [plantId, accessory] of this.accessories.entries()) {
        if (!activePlantIds.has(plantId)) {
          this.log.info(`🗑️ Removendo inversor obsoleto: "${accessory.displayName}" (Plant ID: ${plantId})`);
          this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
          this.accessories.delete(plantId);
        }
      }

      // Adicionar/Atualizar acessórios
      for (const plant of plantData) {
        const plantId = plant.plantId.toString();
        const plantName = plant.plantName;
        const uuid = generateUUID(`growatt-inversor-${plantId}`);
        
        let accessory = this.accessories.get(plantId);

        if (accessory) {
          this.log.info(`✅ Verificando inversor existente: "${plantName}"`);
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

      this.log.info('✅ Descoberta e sincronização finalizadas.');
      this.startPeriodicMonitoring(plantData);

    } catch (error) {
      this.log.error(`❌ ERRO CRÍTICO na descoberta inicial: ${error.message}`);
      this.log.warn('⏳ Tentando novamente em 5 minutos...');
      setTimeout(() => this.initialDiscovery(), 5 * 60 * 1000);
    }
  }

  setupAccessoryServices(accessory) {
    const name = accessory.context.plantName;
    this.log.info(`🔧 Configurando e nomeando serviços para "${name}"...`);

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.plantId)
      .setCharacteristic(Characteristic.FirmwareRevision, '2.2.0');

    const getOrCreateService = (serviceType, displayName, subtype) => {
      let service = accessory.getServiceById(serviceType, subtype);
      if (!service) {
        service = accessory.addService(serviceType, displayName, subtype);
      }
      // Garante que o nome de exibição está sempre atualizado.
      service.setCharacteristic(Characteristic.Name, displayName);
      return service;
    };

    // Sensores de Luz para exibir dados numéricos
    getOrCreateService(Service.LightSensor, 'Produção Hoje (kWh)', 'today_energy');
    getOrCreateService(Service.LightSensor, 'Produção Atual (W)', 'current_power');
    getOrCreateService(Service.LightSensor, 'Produção no Mês (kWh)', 'monthly_energy');
    getOrCreateService(Service.LightSensor, 'Produção Anual (kWh)', 'yearly_energy');
    getOrCreateService(Service.LightSensor, 'Produção Total (kWh)', 'total_energy');

    // Switch para indicar status de produção
    const switchService = getOrCreateService(Service.Switch, 'Produzindo', 'producing_status');
    switchService.getCharacteristic(Characteristic.On).onGet(() => accessory.context.isProducing || false);

    this.log.info(`✅ Serviços para "${name}" nomeados e configurados.`);
  }

  startPeriodicMonitoring(plantData) {
    this.log.info(`⏰ Iniciando monitoramento periódico para ${plantData.length} inversor(es)...`);

    const updateAllData = async () => {
      this.log.info('🔄 Atualizando dados de todos os inversores...');

      try {
        // Buscar dados da API plant/list para obter current_power
        const listResponse = await axios.get('https://openapi.growatt.com/v1/plant/list', {
          headers: { 'token': this.token },
          timeout: 10000
        });

        if (listResponse.data.error_code !== 0) {
          throw new Error(`Erro da API Growatt: ${listResponse.data.error_msg || 'Erro desconhecido'}`);
        }

        const plants = listResponse.data.data?.plants || [];
        
        // Criar um mapa de plantId para current_power
        const powerMap = new Map();
        for (const plant of plants) {
          powerMap.set(plant.plant_id.toString(), parseFloat(plant.current_power) || 0);
        }

        // Atualizar cada acessório com os dados
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
              // Usar current_power da API plant/list
              const currentPower = powerMap.get(plantId) || 0;
              const todayEnergy = parseFloat(data.today_energy) || 0;
              const monthEnergy = parseFloat(data.monthly_energy) || 0;
              const yearlyEnergy = parseFloat(data.yearly_energy) || 0;
              const totalEnergy = parseFloat(data.total_energy) || 0;
              const isProducing = currentPower > 0.1;

              accessory.context.isProducing = isProducing;

              accessory.getServiceById(Service.LightSensor, 'today_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, todayEnergy);
              accessory.getServiceById(Service.LightSensor, 'current_power')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, currentPower);
              accessory.getServiceById(Service.LightSensor, 'monthly_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, monthEnergy);
              accessory.getServiceById(Service.LightSensor, 'yearly_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, yearlyEnergy);
              accessory.getServiceById(Service.LightSensor, 'total_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, totalEnergy);
              accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, isProducing);

              const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
              this.log.info(`⚡ ${accessory.displayName}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Mês: ${monthEnergy.toFixed(2)}kWh | Ano: ${yearlyEnergy.toFixed(2)}kWh | ${status}`);
            } else {
              this.log.warn(`⚠️ Não foi possível obter dados para "${accessory.displayName}". API: ${response.data.error_msg || 'Erro desconhecido'}`);
              this.setAccessoryOffline(accessory);
            }
          } catch (error) {
            this.log.error(`❌ Erro ao contatar API para "${accessory.displayName}": ${error.message}`);
            this.setAccessoryOffline(accessory);
          }
        }
      } catch (error) {
        this.log.error(`❌ Erro ao obter lista de plantas: ${error.message}`);
        // Colocar todos os acessórios offline em caso de falha geral
        for (const accessory of this.accessories.values()) {
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
    accessory.getServiceById(Service.LightSensor, 'monthly_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0);
    // Não zeramos o anual e total, pois são acumulados históricos
    accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, false);
  }
}