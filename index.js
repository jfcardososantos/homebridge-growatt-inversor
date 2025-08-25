const axios = require('axios');

let Service, Characteristic, PlatformAccessory, generateUUID;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  console.log('[Growatt] Carregando plugin...');
  
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  PlatformAccessory = homebridge.platformAccessory;
  generateUUID = homebridge.hap.uuid.generate;

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
    this.accessories = new Map();
    this.plantIds = [];
    
    this.token = this.config.token;
    this.refreshInterval = (this.config.refreshInterval || 5) * 60 * 1000;

    this.log.info('*** GROWATT PLATFORM INICIANDO ***');
    
    if (!this.token) {
      this.log.error('❌ Token não configurado na plataforma!');
      return;
    }

    this.log.info(`🔑 Token: ${this.token.substring(0, 10)}...`);

    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('🚀 Homebridge carregado - iniciando descoberta inicial...');
        this.initialDiscovery();
      });
    }
  }

  configureAccessory(accessory) {
    this.log.info(`📄 Ignorando acessório do cache: ${accessory.displayName || 'desconhecido'}`);
  }

  async initialDiscovery() {
    this.log.info('🔍 DESCOBERTA INICIAL - Buscando Plant IDs...');

    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 'token': this.token },
        timeout: 15000
      });

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg || 'Erro desconhecido'}`);
      }

      const plants = response.data.data?.plants || [];
      
      if (plants.length === 0) {
        this.log.warn('⚠️ Nenhum inversor encontrado na conta!');
        return;
      }

      this.log.info(`📡 Descobertos ${plants.length} inversor(es)`);

      // Salvar Plant IDs em cache
      this.plantIds = plants.map(plant => ({
        plantId: plant.plant_id,
        plantName: plant.name || `Inversor ${plant.plant_id}`,
        city: plant.city || 'Não informado',
        peakPower: plant.peak_power || 0,
        totalEnergy: parseFloat(plant.total_energy) || 0
      }));

      // Configurar acessórios - CADA UM COM UUID ÚNICO
      for (const plantInfo of this.plantIds) {
        this.log.info(`➕ Configurando: ${plantInfo.plantName} (Plant ID: ${plantInfo.plantId})`);
        
        // UUID único baseado no Plant ID específico
        const uuid = generateUUID(`growatt-inversor-${plantInfo.plantId}`);
        const accessory = new PlatformAccessory(plantInfo.plantName, uuid);
        
        accessory.context = {
          plantId: plantInfo.plantId,
          plantName: plantInfo.plantName,
          city: plantInfo.city,
          peakPower: plantInfo.peakPower,
          isProducing: false,
          currentPower: 0,
          todayEnergy: 0,
          totalEnergy: plantInfo.totalEnergy
        };

        // Configurar serviços com subtypes únicos
        this.setupSimpleServices(accessory);
        
        this.accessories.set(plantInfo.plantId.toString(), accessory);
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
        
        this.log.info(`🔧 ${plantInfo.plantName} configurado | Plant ID: ${plantInfo.plantId} | UUID: ${uuid}`);
      }

      this.log.info(`✅ DESCOBERTA INICIAL FINALIZADA: ${this.plantIds.length} inversor(es)`);
      this.startPeriodicMonitoring();

    } catch (error) {
      this.log.error('❌ ERRO na descoberta inicial:');
      this.log.error(`Mensagem: ${error.message}`);
      
      this.log.warn('⏳ Tentando descoberta novamente em 5 minutos...');
      setTimeout(() => this.initialDiscovery(), 5 * 60 * 1000);
    }
  }

  // Configurar serviços com SUBTYPEs únicos para evitar conflitos de UUID
  setupSimpleServices(accessory) {
    const name = accessory.context.plantName;
    const plantId = accessory.context.plantId;
    
    // Serviço de informação básico
    const infoService = accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, plantId.toString())
      .setCharacteristic(Characteristic.FirmwareRevision, '1.2.0');

    // Switch com subtype único baseado no Plant ID
    const switchSubtype = `status-${plantId}`;
    const switchService = accessory.addService(Service.Switch, name, switchSubtype);
    
    switchService
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        return accessory.context.isProducing || false;
      })
      .onSet((value) => {
        this.log.info(`💡 ${name}: Switch ${value ? 'ON' : 'OFF'} (somente leitura)`);
      });

    this.log.info(`🔧 Switch configurado para: ${name} | Subtype: ${switchSubtype}`);
  }

  startPeriodicMonitoring() {
    this.log.info(`⏰ Iniciando monitoramento de ${this.plantIds.length} inversor(es)`);

    const updateAllData = async () => {
      this.log.info('📊 Atualizando dados...');

      for (const plantInfo of this.plantIds) {
        const plantId = plantInfo.plantId;
        const plantName = plantInfo.plantName;
        const accessory = this.accessories.get(plantId.toString());

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
            const totalEnergy = parseFloat(data.total_energy) || 0;
            const isProducing = currentPower > 0.1;

            // Atualizar contexto
            accessory.context.currentPower = currentPower;
            accessory.context.todayEnergy = todayEnergy;
            accessory.context.totalEnergy = totalEnergy;
            accessory.context.isProducing = isProducing;

            // Atualizar switch - buscar pelo subtype correto
            const switchSubtype = `status-${plantId}`;
            const switchService = accessory.getServiceById(Service.Switch, switchSubtype);
            if (switchService) {
              switchService.updateCharacteristic(Characteristic.On, isProducing);
            }

            const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
            this.log.info(`⚡ ${plantName}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Total: ${totalEnergy.toFixed(2)}kWh | ${status}`);
            
          } else {
            this.log.warn(`⚠️ ${plantName}: Dados inválidos da API`);
            this.setOffline(accessory);
          }

        } catch (error) {
          if (error.message.includes('frequently_access')) {
            this.log.warn(`⏳ ${plantName}: Rate limit - aguardando`);
          } else {
            this.log.error(`❌ ${plantName}: ${error.message}`);
          }
          this.setOffline(accessory);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    setTimeout(updateAllData, 10000);
    this.monitoringTimer = setInterval(updateAllData, this.refreshInterval);
    
    this.log.info(`✅ Monitoramento iniciado - atualizações a cada ${this.refreshInterval / 1000 / 60} minutos`);
  }

  setOffline(accessory) {
    const plantId = accessory.context.plantId;
    const switchSubtype = `status-${plantId}`;
    const switchService = accessory.getServiceById(Service.Switch, switchSubtype);
    if (switchService) {
      switchService.updateCharacteristic(Characteristic.On, false);
    }
    accessory.context.isProducing = false;
    accessory.context.currentPower = 0;
  }
}