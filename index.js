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

    // BOTÃO PRINCIPAL - Tomada que simula medidor de energia
    let mainService = accessory.getService(name);
    if (!mainService) {
      mainService = accessory.addService(Service.Outlet, name, 'main');
    }
    
    // Configura o botão principal
    mainService
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        // Retorna true se estiver produzindo energia
        return accessory.context.isProducing || false;
      })
      .onSet((value) => {
        // Não permite desligar o inversor, apenas mostra status
        this.log.info(`💡 ${name}: Tentativa de ${value ? 'ligar' : 'desligar'} (apenas leitura)`);
      });

    // Adiciona consumo de energia (irá mostrar a energia do dia)
    mainService
      .getCharacteristic(Characteristic.OutletInUse)
      .onGet(() => accessory.context.isProducing || false);

    // CARACTERÍSTICAS EXTRAS DE ENERGIA
    // Potência atual em Watts
    if (!mainService.testCharacteristic(Characteristic.CurrentPowerConsumption)) {
      mainService.addCharacteristic(Characteristic.CurrentPowerConsumption);
    }
    
    // Energia total consumida (usaremos para energia gerada do dia)
    if (!mainService.testCharacteristic(Characteristic.TotalConsumption)) {
      mainService.addCharacteristic(Characteristic.TotalConsumption);
    }

    // Voltagem
    if (!mainService.testCharacteristic(Characteristic.Voltage)) {
      mainService.addCharacteristic(Characteristic.Voltage);
    }

    // SENSORES EXTRAS (mantidos para compatibilidade)
    // Sensor de potência total acumulada
    let totalService = accessory.getService('Energia Total');
    if (!totalService) {
      totalService = accessory.addService(Service.LightSensor, 'Energia Total', 'total');
    }
    
    totalService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ 
        minValue: 0, 
        maxValue: 999999,
        minStep: 0.1 
      });

    // Sensor de status detalhado
    let statusService = accessory.getService('Status Detalhado');
    if (!statusService) {
      statusService = accessory.addService(Service.ContactSensor, 'Status Detalhado', 'status');
    }

    this.log.info(`🔧 Medidor de energia configurado para: ${name}`);
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

          // Atualizar contexto
          accessory.context.currentPower = currentPower;
          accessory.context.todayEnergy = todayEnergy;
          accessory.context.totalEnergy = totalEnergy;
          accessory.context.isProducing = isOnline;

          // ATUALIZAR BOTÃO PRINCIPAL (Tomada/Medidor)
          const mainService = accessory.getService(name);
          if (mainService) {
            // Status do botão (ligado/desligado)
            mainService.updateCharacteristic(Characteristic.On, isOnline);
            mainService.updateCharacteristic(Characteristic.OutletInUse, isOnline);
            
            // Potência atual em Watts
            mainService.updateCharacteristic(Characteristic.CurrentPowerConsumption, currentPower);
            
            // Energia do dia (convertendo kWh para Wh para melhor precisão)
            const todayEnergyWh = todayEnergy * 1000; // kWh para Wh
            mainService.updateCharacteristic(Characteristic.TotalConsumption, todayEnergyWh);
            
            // Voltagem simulada (padrão brasileiro 220V)
            mainService.updateCharacteristic(Characteristic.Voltage, 220);
          }

          // ATUALIZAR SENSORES EXTRAS
          // Sensor de energia total
          const totalService = accessory.getService('Energia Total');
          if (totalService) {
            totalService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, totalEnergy);
          }
          
          // Sensor de status detalhado
          const statusService = accessory.getService('Status Detalhado');
          if (statusService) {
            statusService.updateCharacteristic(
              Characteristic.ContactSensorState, 
              isOnline ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            );
          }

          this.log.info(`📊 ${name}: ${currentPower}W | Hoje: ${todayEnergy}kWh | Total: ${totalEnergy}kWh | ${isOnline ? '🟢 Produzindo' : '🔴 Offline'}`);
        } else {
          this.log.warn(`⚠️ ${name}: Dados inválidos recebidos da API`);
        }
      } catch (error) {
        this.log.error(`❌ ${name}: Erro ao atualizar - ${error.message}`);
        
        // Marcar como offline em caso de erro
        const mainService = accessory.getService(name);
        if (mainService) {
          mainService.updateCharacteristic(Characteristic.On, false);
          mainService.updateCharacteristic(Characteristic.OutletInUse, false);
        }
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