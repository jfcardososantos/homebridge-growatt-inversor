const axios = require('axios');

let Service, Characteristic, PlatformAccessory;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  console.log('[Growatt] Carregando plugin...');
  
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
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
    this.accessories = new Map();
    this.plantIds = []; // Cache dos Plant IDs descobertos
    
    this.token = this.config.token;
    this.refreshInterval = (this.config.refreshInterval || 5) * 60 * 1000;

    this.log.info('*** GROWATT PLATFORM INICIANDO ***');
    
    if (!this.token) {
      this.log.error('❌ Token não configurado na plataforma!');
      return;
    }

    this.log.info(`🔑 Token: ${this.token.substring(0, 10)}...`);

    // Aguarda carregar completamente
    if (this.api) {
      this.api.on('didFinishLaunching', () => {
        this.log.info('🚀 Homebridge carregado - iniciando descoberta inicial...');
        this.initialDiscovery();
      });
    }
  }

  // Não usar cache - ignorar qualquer acessório existente
  configureAccessory(accessory) {
    this.log.info(`📄 Ignorando acessório do cache: ${accessory.displayName || 'desconhecido'}`);
  }

  // Descoberta inicial - executa só UMA VEZ na inicialização
  async initialDiscovery() {
    this.log.info('🔍 DESCOBERTA INICIAL - Buscando Plant IDs (só executa na inicialização)...');

    try {
      // Chamada ÚNICA para descobrir os Plant IDs
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

      // Configurar acessórios para cada Plant ID
      for (const plantInfo of this.plantIds) {
        this.log.info(`➕ Configurando: ${plantInfo.plantName} (Plant ID: ${plantInfo.plantId})`);
        
        const accessory = new PlatformAccessory(plantInfo.plantName, plantInfo.plantId.toString());
        
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

        this.configureAccessoryServices(accessory);
        this.accessories.set(plantInfo.plantId.toString(), accessory);
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
        
        this.log.info(`🔧 ${plantInfo.plantName} configurado | Plant ID: ${plantInfo.plantId} | Peak: ${plantInfo.peakPower}W`);
      }

      this.log.info(`✅ DESCOBERTA INICIAL FINALIZADA: ${this.plantIds.length} inversor(es) configurado(s)`);
      this.log.info('🔄 Iniciando monitoramento contínuo...');

      // Iniciar monitoramento periódico de TODOS os inversores
      this.startPeriodicMonitoring();

    } catch (error) {
      this.log.error('❌ ERRO na descoberta inicial:');
      this.log.error(`Mensagem: ${error.message}`);
      
      if (error.response) {
        this.log.error(`Status HTTP: ${error.response.status}`);
        if (error.response.data) {
          this.log.error(`Resposta da API: ${JSON.stringify(error.response.data)}`);
        }
      }

      // Tentar novamente em 5 minutos se falhar
      this.log.warn('⏳ Tentando descoberta novamente em 5 minutos...');
      setTimeout(() => this.initialDiscovery(), 5 * 60 * 1000);
    }
  }

  // Monitoramento periódico - usa os Plant IDs em cache
  startPeriodicMonitoring() {
    this.log.info(`⏰ Iniciando monitoramento contínuo de ${this.plantIds.length} inversor(es)`);
    this.log.info(`🔄 Intervalo: ${this.refreshInterval / 1000 / 60} minutos`);

    const updateAllData = async () => {
      this.log.info('📊 Atualizando dados de todos os inversores...');

      for (const plantInfo of this.plantIds) {
        const plantId = plantInfo.plantId;
        const plantName = plantInfo.plantName;
        const accessory = this.accessories.get(plantId.toString());

        if (!accessory) {
          this.log.warn(`⚠️ Acessório não encontrado para Plant ID: ${plantId}`);
          continue;
        }

        try {
          // Buscar dados específicos usando Plant ID em cache
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
            accessory.context.lastUpdate = new Date().toISOString();

            // Atualizar serviços HomeKit
            this.updateAccessoryServices(accessory);

            const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
            this.log.info(`⚡ ${plantName}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Total: ${totalEnergy.toFixed(2)}kWh | ${status}`);
            
          } else {
            this.log.warn(`⚠️ ${plantName}: Dados inválidos da API`);
            this.handleOfflineStatus(accessory);
          }

        } catch (error) {
          if (error.message.includes('frequently_access')) {
            this.log.warn(`⏳ ${plantName}: Rate limit - aguardando próximo ciclo`);
          } else {
            this.log.error(`❌ ${plantName}: Erro no monitoramento - ${error.message}`);
          }
          this.handleOfflineStatus(accessory);
        }

        // Pequena pausa entre as chamadas para evitar sobrecarga
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    // Primeira atualização em 10 segundos
    setTimeout(updateAllData, 10000);
    
    // Monitoramento periódico a cada intervalo configurado
    this.monitoringTimer = setInterval(updateAllData, this.refreshInterval);
    
    this.log.info(`✅ Monitoramento contínuo iniciado para ${this.plantIds.length} inversor(es)`);
  }

  // Atualizar serviços do acessório com novos dados
  updateAccessoryServices(accessory) {
    const energyService = accessory.getService('Produção Solar');
    if (energyService) {
      energyService.updateCharacteristic(Characteristic.On, accessory.context.isProducing);
      energyService.updateCharacteristic(Characteristic.TotalConsumption, accessory.context.todayEnergy * 1000);
      energyService.updateCharacteristic(Characteristic.CurrentPowerConsumption, accessory.context.currentPower);
      energyService.updateCharacteristic(Characteristic.Voltage, 220);
    }

    const totalService = accessory.getService('Energia Total Histórica');
    if (totalService) {
      totalService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, accessory.context.totalEnergy);
    }
    
    const statusService = accessory.getService('Status Operacional');
    if (statusService) {
      statusService.updateCharacteristic(Characteristic.MotionDetected, accessory.context.isProducing);
    }
  }

  configureAccessoryServices(accessory) {
    const name = accessory.context.plantName;
    
    // Serviço de informação
    let infoService = accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.plantId.toString())
      .setCharacteristic(Characteristic.FirmwareRevision, '1.2.0');

    // 🔋 MEDIDOR DE ENERGIA PRINCIPAL
    let energyService = accessory.addService(Service.Outlet, 'Produção Solar');
    energyService.setCharacteristic(Characteristic.Name, `${name} - Energia Hoje`);

    // Adicionar características de energia
    energyService.addCharacteristic(Characteristic.TotalConsumption);
    energyService.addCharacteristic(Characteristic.CurrentPowerConsumption);
    energyService.addCharacteristic(Characteristic.Voltage);

    // Status de produção (on/off)
    energyService
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        return accessory.context.isProducing || false;
      });

    // 📊 SENSOR DE ENERGIA TOTAL HISTÓRICA
    let totalService = accessory.addService(Service.LightSensor, 'Energia Total Histórica');
    totalService
      .setCharacteristic(Characteristic.Name, `${name} - Total Histórico`)
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ 
        minValue: 0, 
        maxValue: 999999,
        minStep: 0.01
      });

    // 🟢 SENSOR DE STATUS
    let statusService = accessory.addService(Service.MotionSensor, 'Status Operacional');
    statusService
      .setCharacteristic(Characteristic.Name, `${name} - Status`)
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => {
        return accessory.context.isProducing || false;
      });

    this.log.info(`🔧 Serviços configurados para: ${name}`);
  }

  // Tratar status offline
  handleOfflineStatus(accessory) {
    const name = accessory.context.plantName;
    
    const energyService = accessory.getService('Produção Solar');
    if (energyService) {
      energyService.updateCharacteristic(Characteristic.On, false);
      energyService.updateCharacteristic(Characteristic.CurrentPowerConsumption, 0);
    }

    const statusService = accessory.getService('Status Operacional');
    if (statusService) {
      statusService.updateCharacteristic(Characteristic.MotionDetected, false);
    }

    accessory.context.isProducing = false;
    accessory.context.currentPower = 0;
    
    this.log.warn(`🔴 ${name}: OFFLINE`);
  }
}
