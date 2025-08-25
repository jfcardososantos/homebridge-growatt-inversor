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
      .setCharacteristic(Characteristic.FirmwareRevision, '1.2.0');

    // 🔋 MEDIDOR DE ENERGIA PRINCIPAL - Usando SmartMeter Service
    let energyService = accessory.getService('Produção Solar');
    if (!energyService) {
      energyService = accessory.addService(Service.SmartMeter, 'Produção Solar', 'energy-meter');
    }

    // Configurações do medidor de energia elétrica
    energyService
      .setCharacteristic(Characteristic.Name, `${name} - Energia Hoje`)
      .setCharacteristic(Characteristic.ConfiguredName, `${name} - Energia Hoje`);

    // ⚡ Energia total consumida/gerada (hoje em kWh)
    if (!energyService.testCharacteristic(Characteristic.TotalConsumption)) {
      energyService.addCharacteristic(Characteristic.TotalConsumption);
    }

    // 🔌 Potência atual instantânea (W)
    if (!energyService.testCharacteristic(Characteristic.CurrentPowerConsumption)) {
      energyService.addCharacteristic(Characteristic.CurrentPowerConsumption);
    }

    // 🔆 Status de produção (ativo/inativo)
    energyService
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        return accessory.context.isProducing || false;
      })
      .onSet((value) => {
        this.log.info(`💡 ${name}: Status de produção ${value ? 'ATIVO' : 'INATIVO'} (somente leitura)`);
      });

    // ⚡ Voltagem da rede (padrão brasileiro)
    if (!energyService.testCharacteristic(Characteristic.Voltage)) {
      energyService.addCharacteristic(Characteristic.Voltage);
    }

    // 📊 SENSOR ADICIONAL - Energia Total Histórica
    let totalService = accessory.getService('Energia Total Histórica');
    if (!totalService) {
      totalService = accessory.addService(Service.LightSensor, 'Energia Total Histórica', 'total-energy');
    }
    
    totalService
      .setCharacteristic(Characteristic.Name, `${name} - Total Histórico`)
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ 
        minValue: 0, 
        maxValue: 999999,
        minStep: 0.01,
        unit: 'kWh'
      });

    // 🟢 SENSOR DE STATUS - Online/Offline
    let statusService = accessory.getService('Status Operacional');
    if (!statusService) {
      statusService = accessory.addService(Service.MotionSensor, 'Status Operacional', 'status-sensor');
    }

    statusService
      .setCharacteristic(Characteristic.Name, `${name} - Status`)
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => {
        return accessory.context.isProducing || false;
      });

    this.log.info(`🔧 Medidor de energia solar configurado para: ${name}`);
  }

  startMonitoring(accessory) {
    const plantId = accessory.context.plantId;
    const name = accessory.context.plantName;
    
    // Limpar timer existente se houver
    if (accessory.updateTimer) {
      clearInterval(accessory.updateTimer);
    }

    this.log.info(`⏰ Iniciando monitoramento de energia: ${name}`);

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
          const isProducing = currentPower > 0.1; // Considera produzindo se > 0.1W

          // Atualizar contexto
          accessory.context.currentPower = currentPower;
          accessory.context.todayEnergy = todayEnergy;
          accessory.context.totalEnergy = totalEnergy;
          accessory.context.isProducing = isProducing;
          accessory.context.lastUpdate = new Date().toISOString();

          // 🔋 ATUALIZAR MEDIDOR DE ENERGIA PRINCIPAL
          const energyService = accessory.getService('Produção Solar');
          if (energyService) {
            // Status de produção (on/off)
            energyService.updateCharacteristic(Characteristic.On, isProducing);
            
            // ⚡ Energia do dia em kWh (multiplicado por 1000 para conversão Wh->kWh no HomeKit)
            // O HomeKit mostra TotalConsumption em kWh automaticamente
            const todayEnergyWh = todayEnergy * 1000; // Converter kWh para Wh
            energyService.updateCharacteristic(Characteristic.TotalConsumption, todayEnergyWh);
            
            // 🔌 Potência atual em Watts
            energyService.updateCharacteristic(Characteristic.CurrentPowerConsumption, currentPower);
            
            // 🔆 Voltagem da rede (220V padrão brasileiro)
            energyService.updateCharacteristic(Characteristic.Voltage, 220);
          }

          // 📊 ATUALIZAR SENSOR DE ENERGIA TOTAL HISTÓRICA
          const totalService = accessory.getService('Energia Total Histórica');
          if (totalService) {
            // Usar o valor total em kWh diretamente
            totalService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, totalEnergy);
          }
          
          // 🟢 ATUALIZAR STATUS OPERACIONAL
          const statusService = accessory.getService('Status Operacional');
          if (statusService) {
            statusService.updateCharacteristic(Characteristic.MotionDetected, isProducing);
          }

          // Log detalhado
          const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
          this.log.info(`⚡ ${name}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Total: ${totalEnergy.toFixed(2)}kWh | ${status}`);
          
        } else {
          this.log.warn(`⚠️ ${name}: Dados inválidos recebidos da API`);
          this.handleOfflineStatus(accessory);
        }
      } catch (error) {
        this.log.error(`❌ ${name}: Erro ao atualizar - ${error.message}`);
        this.handleOfflineStatus(accessory);
      }
    };

    // Primeira atualização em 3 segundos
    setTimeout(updateData, 3000);
    
    // Atualização periódica a cada intervalo configurado
    accessory.updateTimer = setInterval(updateData, this.refreshInterval);
    
    this.log.info(`🔄 ${name}: Atualizações a cada ${this.refreshInterval / 1000 / 60} minutos`);
  }

  // Tratar status offline
  handleOfflineStatus(accessory) {
    const name = accessory.context.plantName;
    
    // Marcar como offline em todos os serviços
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
    
    this.log.warn(`🔴 ${name}: Marcado como OFFLINE`);
  }

  // Cleanup quando removido
  removeAccessory(accessory) {
    if (accessory.updateTimer) {
      clearInterval(accessory.updateTimer);
    }
    this.accessories.delete(accessory.UUID);
    this.log.info(`🗑️ Acessório removido: ${accessory.context.plantName}`);
  }
}