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

      // Manter um registro de todos os acessórios ativos
      const activeAccessories = new Set();

      // Para cada planta, buscar seus dispositivos
      for (const plant of plants) {
        const plantId = plant.plant_id.toString();
        const plantName = plant.name || `Inversor ${plant.plant_id}`;
        
        try {
          // Buscar dispositivos desta planta
          const deviceListResponse = await axios.get(`https://openapi.growatt.com/v1/device/list?plant_id=${plantId}`, {
            headers: { 'token': this.token },
            timeout: 10000
          });

          if (deviceListResponse.data.error_code !== 0 || !deviceListResponse.data.data?.devices?.length) {
            this.log.warn(`⚠️ Nenhum dispositivo encontrado para planta "${plantName}"`);
            continue;
          }

          // Iterar sobre cada dispositivo da planta
          for (const device of deviceListResponse.data.data.devices) {
            const deviceSN = device.device_sn;
            if (!deviceSN) {
              this.log.warn(`⚠️ Dispositivo sem SN na planta "${plantName}"`);
              continue;
            }

            // Criar um ID único para este dispositivo
            const deviceId = `${plantId}-${deviceSN}`;
            activeAccessories.add(deviceId);

            // Nome do dispositivo
            const deviceName = `${plantName}`;
            const uuid = generateUUID(`growatt-inversor-${plantId}`);
            
            let accessory = this.accessories.get(plantId);

            if (accessory) {
              this.log.info(`✅ Verificando dispositivo existente: "${deviceName}"`);
              accessory.displayName = deviceName;
              accessory.context.plantName = plantName;
              accessory.context.plantId = plantId;
              accessory.context.deviceSN = deviceSN;
              accessory.context.deviceType = device.type;
              accessory.context.manufacturer = device.manufacturer;
            } else {
              this.log.info(`➕ Adicionando novo dispositivo: "${deviceName}"`);
              accessory = new PlatformAccessory(deviceName, uuid);
              accessory.context.plantId = plantId;
              accessory.context.plantName = plantName;
              accessory.context.deviceSN = deviceSN;
              accessory.context.deviceType = device.type;
              accessory.context.manufacturer = device.manufacturer;
              
              this.accessories.set(plantId, accessory);
              this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
            }

            this.setupAccessoryServices(accessory);
            this.log.info(`🔧 "${deviceName}" configurado com sucesso.`);
          }
        } catch (error) {
          this.log.error(`❌ Erro ao buscar dispositivos para planta "${plantName}": ${error.message}`);
        }
      }

      // Remover acessórios que não estão mais ativos
      for (const [deviceId, accessory] of this.accessories.entries()) {
        if (!activeAccessories.has(accessory.context.plantId)) {
          this.log.info(`🗑️ Removendo dispositivo obsoleto: "${accessory.displayName}" (ID: ${deviceId})`);
          this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
          this.accessories.delete(deviceId);
        }
      }

      this.log.info('✅ Descoberta e sincronização finalizadas.');
      this.startPeriodicMonitoring();

    } catch (error) {
      this.log.error(`❌ ERRO CRÍTICO na descoberta inicial: ${error.message}`);
      this.log.warn('⏳ Tentando novamente em 5 minutos...');
      setTimeout(() => this.initialDiscovery(), 5 * 60 * 1000);
    }
  }

  startPeriodicMonitoring() {
    this.log.info(`⏰ Iniciando monitoramento periódico para ${this.accessories.size} dispositivo(s)...`);

    const updateAllData = async () => {
      this.log.info('🔄 Atualizando dados de todos os dispositivos...');

      // Atualizar cada acessório com os dados
      for (const [plantId, accessory] of this.accessories.entries()) {
        const deviceSN = accessory.context.deviceSN;
        
        if (!deviceSN) {
          this.log.warn(`⚠️ Dispositivo "${accessory.displayName}" sem SN configurado`);
          this.setAccessoryOffline(accessory);
          continue;
        }

        let currentPower = 0;
        let todayEnergy = 0;
        let monthEnergy = 0;
        let yearlyEnergy = 0;
        let totalEnergy = 0;
        let isProducing = false;

        try {
          // 1. Obter current_power e plant_id da rota plant/list usando device_id (deviceSN)
          const plantListUrl = `https://openapi.growatt.com/v1/plant/list?device_id=${deviceSN}`;
          this.log.debug(`DEBUG: Chamando API plant/list para ${accessory.displayName}. URL: ${plantListUrl}`);
          const plantListResponse = await axios.get(plantListUrl, {
            headers: { 'token': this.token },
            timeout: 10000
          });
          this.log.debug(`DEBUG: Resposta da API plant/list para ${accessory.displayName}: ${JSON.stringify(plantListResponse.data)}`);

          if (plantListResponse.data.error_code !== 0) {
            this.log.warn(`⚠️ Não foi possível obter dados de produção atual para "${accessory.displayName}". API: ${plantListResponse.data.error_msg || 'Erro desconhecido'}`);
            this.setAccessoryOffline(accessory);
            continue;
          }

          const plantsFromList = plantListResponse.data.data?.plants || [];
          if (plantsFromList.length === 0) {
            this.log.warn(`⚠️ Nenhum dado de planta retornado para "${accessory.displayName}" na rota plant/list`);
            this.setAccessoryOffline(accessory);
            continue;
          }

          // Encontrar a planta correspondente ou usar a primeira
          const plantInfoFromList = plantsFromList.find(p => p.plant_id.toString() === plantId) || plantsFromList[0];
          currentPower = parseFloat(plantInfoFromList.current_power) || 0;
          isProducing = currentPower > 1;

          // 2. Usar o plant_id para buscar dados anuais, mensais, totais e diários da rota plant/data
          try {
            const plantDataUrl = `https://openapi.growatt.com/v1/plant/data?plant_id=${plantId}`;
            this.log.debug(`DEBUG: Chamando API plant/data para ${accessory.displayName} com plant_id: ${plantId}. URL: ${plantDataUrl}`);
            const plantDataResponse = await axios.get(plantDataUrl, {
              headers: { 'token': this.token },
              timeout: 10000
            });
            this.log.debug(`DEBUG: Resposta da API plant/data para ${accessory.displayName}: ${JSON.stringify(plantDataResponse.data)}`);


            // A resposta da API plant/data vem em um array, precisamos acessar o primeiro elemento
            const apiResponse = plantDataResponse.data;
            if (!Array.isArray(apiResponse) || apiResponse.length === 0) {
              this.log.warn(`⚠️ Resposta inesperada da API plant/data para "${accessory.displayName}" (plant_id: ${plantId}). Dados históricos serão exibidos como zero.`);
            } else {
              const plantDataEntry = apiResponse[0]; // Pega o primeiro objeto do array

              if (plantDataEntry.error_code !== 0) {
                this.log.warn(`⚠️ Não foi possível obter dados históricos para "${accessory.displayName}" (plant_id: ${plantId}). API retornou erro: ${plantDataEntry.error_msg || 'Erro desconhecido'}. Dados históricos serão exibidos como zero.`);
              } else {
                const plantData = plantDataEntry.data;
                todayEnergy = parseFloat(plantData.today_energy) || 0;
                monthEnergy = parseFloat(plantData.monthly_energy) || 0;
                yearlyEnergy = parseFloat(plantData.yearly_energy) || 0;
                totalEnergy = parseFloat(plantData.total_energy) || 0;
              }
            }
          } catch (error) {
            this.log.error(`❌ Erro na requisição da API plant/data para "${accessory.displayName}" (plant_id: ${plantId}): ${error.message}. Dados históricos serão exibidos como zero.`);
            // Os valores permanecem 0 como inicializados
          }

          // Atualizar o acessório
          accessory.context.isProducing = isProducing;

          // Helper function to handle 0 values for LightSensor characteristics
          const updateLightSensorCharacteristic = (service, characteristicName, value) => {
            // Homebridge LightSensor (CurrentAmbientLightLevel) has a minimum of 0.0001.
            // If the actual value is 0, we set it to 0.0001 to avoid warnings.
            const safeValue = value > 0 ? value : 0.0001; 
            service?.updateCharacteristic(characteristicName, safeValue);
          };

          updateLightSensorCharacteristic(accessory.getServiceById(Service.LightSensor, 'today_energy'), Characteristic.CurrentAmbientLightLevel, todayEnergy);
          updateLightSensorCharacteristic(accessory.getServiceById(Service.LightSensor, 'current_power'), Characteristic.CurrentAmbientLightLevel, currentPower);
          updateLightSensorCharacteristic(accessory.getServiceById(Service.LightSensor, 'monthly_energy'), Characteristic.CurrentAmbientLightLevel, monthEnergy);
          updateLightSensorCharacteristic(accessory.getServiceById(Service.LightSensor, 'yearly_energy'), Characteristic.CurrentAmbientLightLevel, yearlyEnergy);
          updateLightSensorCharacteristic(accessory.getServiceById(Service.LightSensor, 'total_energy'), Characteristic.CurrentAmbientLightLevel, totalEnergy);
          
          accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, isProducing);

          const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
          this.log.info(`⚡ ${accessory.displayName}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Mês: ${monthEnergy.toFixed(2)}kWh | Ano: ${yearlyEnergy.toFixed(2)}kWh | ${status}`);
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

  setAccessoryOffline(accessory) {
    this.log.warn(`🔌 Colocando "${accessory.displayName}" em modo offline.`);
    accessory.context.isProducing = false;
    accessory.getServiceById(Service.LightSensor, 'today_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0.0001);
    accessory.getServiceById(Service.LightSensor, 'current_power')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0.0001);
    accessory.getServiceById(Service.LightSensor, 'monthly_energy')?.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, 0.0001);
    // Não zeramos o anual e total, pois são acumulados históricos
    accessory.getServiceById(Service.Switch, 'producing_status')?.updateCharacteristic(Characteristic.On, false);
  }
}
