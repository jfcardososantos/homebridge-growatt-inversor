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
        this.log.info('🚀 Homebridge carregado - iniciando descoberta...');
        this.discoverDevicesWithRetry();
      });
    }
  }

  // Não usar cache de acessórios - sempre criar novos baseados na API
  configureAccessory(accessory) {
    this.log.info(`📄 Ignorando acessório do cache: ${accessory.displayName || 'desconhecido'}`);
    // Não fazemos nada - vamos recriar tudo baseado na API
  }

  // Descoberta com retry automático para erro de rate limit
  async discoverDevicesWithRetry(retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = 5 * 60 * 1000; // 5 minutos
    
    try {
      await this.discoverDevices();
    } catch (error) {
      const isRateLimitError = error.message.includes('frequently_access') || 
                              error.message.includes('rate') || 
                              error.message.includes('limit');
      
      if (isRateLimitError && retryCount < maxRetries) {
        this.log.warn(`⏳ Rate limit detectado. Tentativa ${retryCount + 1}/${maxRetries + 1}. Aguardando 5 minutos...`);
        
        setTimeout(() => {
          this.log.info(`🔄 Tentando descoberta novamente (tentativa ${retryCount + 2}/${maxRetries + 1})...`);
          this.discoverDevicesWithRetry(retryCount + 1);
        }, retryDelay);
        
      } else if (retryCount >= maxRetries) {
        this.log.error(`❌ Falha na descoberta após ${maxRetries + 1} tentativas. Verifique suas credenciais ou tente mais tarde.`);
      } else {
        this.log.error(`❌ Erro não relacionado a rate limit: ${error.message}`);
      }
    }
  }

  async discoverDevices() {
    this.log.info('🔍 Descobrindo inversores...');

    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: { 'token': this.token },
        timeout: 15000
      });

      this.log.info(`📡 API de descoberta respondeu com ${response.data.data?.plants?.length || 0} inversor(es)`);

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg || 'Erro desconhecido'}`);
      }

      const plants = response.data.data?.plants || [];
      
      if (plants.length === 0) {
        this.log.warn('⚠️ Nenhum inversor encontrado na conta!');
        return;
      }

      this.log.info(`📊 DESCOBERTA CONCLUÍDA: ${plants.length} inversor(es) encontrado(s)`);

      // Processar cada planta/inversor
      for (const plant of plants) {
        const plantId = plant.plant_id;
        const plantName = plant.name || `Inversor ${plantId}`;
        
        this.log.info(`➕ Configurando inversor: ${plantName} (Plant ID: ${plantId})`);
        
        // Criar acessório simples sem UUID complicado
        const accessory = this.createSimpleAccessory(plantName, plantId);
        
        // Configurar contexto
        accessory.context = {
          plantId: plantId,
          plantName: plantName,
          city: plant.city || 'Não informado',
          peakPower: plant.peak_power || 0,
          isProducing: false,
          currentPower: 0,
          todayEnergy: 0,
          totalEnergy: parseFloat(plant.total_energy) || 0
        };

        // Configurar serviços
        this.configureAccessoryServices(accessory);
        
        // Armazenar por plant_id
        this.accessories.set(plantId.toString(), accessory);
        
        // Registrar no Homebridge
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', [accessory]);
        
        // Iniciar monitoramento
        this.startMonitoring(accessory);
        
        this.log.info(`🔧 Inversor configurado: ${plantName} | Plant ID: ${plantId} | Peak: ${plant.peak_power}W`);
      }

      this.log.info(`✅ DESCOBERTA FINALIZADA: ${plants.length} inversor(es) configurado(s) com sucesso!`);
      this.log.info('🔄 Agora os dados dos inversores serão monitorados individualmente a cada 5 minutos');

    } catch (error) {
      this.log.error('❌ ERRO na descoberta inicial:');
      this.log.error(`Mensagem: ${error.message}`);
      
      if (error.response) {
        this.log.error(`Status HTTP: ${error.response.status}`);
        if (error.response.data) {
          this.log.error(`Resposta da API: ${JSON.stringify(error.response.data)}`);
        }
      }
      
      // Re-lançar o erro para ser tratado pelo retry
      throw error;
    }
  }

  // Criar acessório simples sem complicações de UUID
  createSimpleAccessory(name, plantId) {
    // UUID simples baseado no Plant ID
    const uuid = `growatt-${plantId}`;
    return new PlatformAccessory(name, uuid);
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

    // 🔋 MEDIDOR DE ENERGIA PRINCIPAL - Usando Outlet
    let energyService = accessory.addService(Service.Outlet, 'Produção Solar', 'energy-meter');

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
      })
      .onSet((value) => {
        this.log.info(`💡 ${name}: Status de produção ${value ? 'ATIVO' : 'INATIVO'} (somente leitura)`);
      });

    // 📊 SENSOR DE ENERGIA TOTAL HISTÓRICA
    let totalService = accessory.addService(Service.LightSensor, 'Energia Total Histórica', 'total-energy');
    
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
    let statusService = accessory.addService(Service.MotionSensor, 'Status Operacional', 'status-sensor');

    statusService
      .setCharacteristic(Characteristic.Name, `${name} - Status`)
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => {
        return accessory.context.isProducing || false;
      });

    this.log.info(`🔧 Serviços configurados para: ${name}`);
  }

  startMonitoring(accessory) {
    const plantId = accessory.context.plantId;
    const name = accessory.context.plantName;
    
    this.log.info(`⏰ Iniciando monitoramento: ${name} (Plant ID: ${plantId})`);

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
          const isProducing = currentPower > 0.1;

          // Atualizar contexto
          accessory.context.currentPower = currentPower;
          accessory.context.todayEnergy = todayEnergy;
          accessory.context.totalEnergy = totalEnergy;
          accessory.context.isProducing = isProducing;
          accessory.context.lastUpdate = new Date().toISOString();

          // Atualizar serviços
          const energyService = accessory.getService('Produção Solar');
          if (energyService) {
            energyService.updateCharacteristic(Characteristic.On, isProducing);
            energyService.updateCharacteristic(Characteristic.TotalConsumption, todayEnergy * 1000);
            energyService.updateCharacteristic(Characteristic.CurrentPowerConsumption, currentPower);
            energyService.updateCharacteristic(Characteristic.Voltage, 220);
          }

          const totalService = accessory.getService('Energia Total Histórica');
          if (totalService) {
            totalService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, totalEnergy);
          }
          
          const statusService = accessory.getService('Status Operacional');
          if (statusService) {
            statusService.updateCharacteristic(Characteristic.MotionDetected, isProducing);
          }

          const status = isProducing ? '🟢 PRODUZINDO' : '🔴 OFFLINE';
          this.log.info(`⚡ ${name}: ${currentPower.toFixed(1)}W | Hoje: ${todayEnergy.toFixed(2)}kWh | Total: ${totalEnergy.toFixed(2)}kWh | ${status}`);
          
        } else {
          this.log.warn(`⚠️ ${name}: Dados inválidos da API`);
          this.handleOfflineStatus(accessory);
        }
      } catch (error) {
        if (error.message.includes('frequently_access')) {
          this.log.warn(`⏳ ${name}: Rate limit - aguardando próximo ciclo`);
        } else {
          this.log.error(`❌ ${name}: Erro no monitoramento - ${error.message}`);
        }
        this.handleOfflineStatus(accessory);
      }
    };

    // Primeira atualização em 10 segundos
    setTimeout(updateData, 10000);
    
    // Atualização periódica
    accessory.updateTimer = setInterval(updateData, this.refreshInterval);
    
    this.log.info(`🔄 ${name}: Monitoramento a cada ${this.refreshInterval / 1000 / 60} minutos`);
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