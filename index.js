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
        this.discoverDevicesWithRetry();
      });
    }
  }

  // Configurar acessórios já em cache
  configureAccessory(accessory) {
    // Validação mais rigorosa do acessório
    if (!accessory || typeof accessory !== 'object') {
      this.log.warn('⚠️ Acessório inválido (null/undefined) encontrado no cache, ignorando...');
      return;
    }

    if (!accessory.context || !accessory.context.plantId) {
      this.log.warn('⚠️ Acessório sem Plant ID encontrado no cache, ignorando...');
      return;
    }

    this.log.info(`📄 Carregando do cache: ${accessory.displayName} (Plant ID: ${accessory.context.plantId})`);
    this.cachedAccessories.push(accessory);
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
    this.log.info('🔍 Descobrindo inversores... (DESCOBERTA INICIAL - só executa na inicialização)');

    try {
      // Limpar acessórios inválidos primeiro
      this.cachedAccessories = this.cachedAccessories.filter(acc => {
        return acc && acc.context && acc.context.plantId;
      });

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

      const toAdd = [];
      const processedPlantIds = new Set();

      for (const plant of plants) {
        const plantId = plant.plant_id;
        const plantName = plant.name || `Inversor ${plantId}`;
        
        // Evitar duplicatas
        if (processedPlantIds.has(plantId)) {
          this.log.warn(`⚠️ Plant ID ${plantId} duplicado, ignorando...`);
          continue;
        }
        processedPlantIds.add(plantId);
        
        // Buscar acessório existente pelo Plant ID
        let accessory = this.cachedAccessories.find(acc => 
          acc && acc.context && acc.context.plantId === plantId
        );
        
        if (!accessory) {
          this.log.info(`➕ Criando novo acessório: ${plantName} (Plant ID: ${plantId})`);
          
          // Criar UUID baseado no Plant ID para garantir unicidade
          const uuid = this.generateUUIDFromPlantId(plantId);
          accessory = new PlatformAccessory(plantName, uuid);
          toAdd.push(accessory);
        } else {
          this.log.info(`✅ Reutilizando acessório: ${plantName} (Plant ID: ${plantId})`);
        }

        // Configurar contexto com validação
        if (!accessory.context) {
          accessory.context = {};
        }
        
        accessory.context.plantId = plantId;
        accessory.context.plantName = plantName;
        accessory.context.city = plant.city || 'Não informado';
        accessory.context.peakPower = plant.peak_power || 0;
        accessory.context.isProducing = false;
        accessory.context.currentPower = 0;
        accessory.context.todayEnergy = 0;
        accessory.context.totalEnergy = parseFloat(plant.total_energy) || 0;

        // Configurar serviços
        this.configureAccessoryServices(accessory);
        
        // Iniciar monitoramento
        this.startMonitoring(accessory);
        
        // Armazenar por plant_id para facilitar acesso
        this.accessories.set(plantId.toString(), accessory);
        
        this.log.info(`🔧 Inversor configurado: ${plantName} | Plant ID: ${plantId} | Peak: ${plant.peak_power}W`);
      }

      // Limpar acessórios obsoletos (que não existem mais na API)
      const currentPlantIds = plants.map(p => p.plant_id);
      const toRemove = this.cachedAccessories.filter(accessory => {
        if (!accessory || !accessory.context || !accessory.context.plantId) {
          return true; // Remove acessórios inválidos
        }
        return !currentPlantIds.includes(accessory.context.plantId);
      });
      
      if (toRemove.length > 0) {
        this.log.info(`🗑️ Removendo ${toRemove.length} acessório(s) obsoleto(s)`);
        this.api.unregisterPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', toRemove);
      }

      // Registrar novos acessórios
      if (toAdd.length > 0) {
        this.log.info(`🏠 Registrando ${toAdd.length} novo(s) acessório(s)`);
        this.api.registerPlatformAccessories('homebridge-growatt-inversor', 'GrowattInversor', toAdd);
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

  // Gerar UUID determinístico baseado no Plant ID
  generateUUIDFromPlantId(plantId) {
    // Usar um namespace fixo + Plant ID para garantir que o mesmo Plant ID sempre gere o mesmo UUID
    const namespace = 'growatt-solar-';
    const input = namespace + plantId.toString();
    
    // Criar um hash simples determinístico para usar como UUID
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Converter para 32bit integer
    }
    
    // Converter para formato UUID-like (8-4-4-4-12)
    const hashStr = Math.abs(hash).toString(16).padStart(8, '0');
    const uuid = [
      hashStr.substr(0, 8),
      '4' + hashStr.substr(1, 3), // Versão 4 UUID
      '8' + hashStr.substr(4, 3), // Variant bits
      hashStr.substr(0, 4),
      (plantId.toString() + '000000000000').substr(0, 12) // Plant ID como sufixo
    ].join('-');
    
    return uuid;
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

    // 🔋 MEDIDOR DE ENERGIA PRINCIPAL - Usando Outlet com características de energia
    let energyService = accessory.getService('Produção Solar');
    if (!energyService) {
      // Usar Outlet que suporta medição de energia
      energyService = accessory.addService(Service.Outlet, 'Produção Solar', 'energy-meter');
    } else if (energyService.constructor.name !== 'Outlet') {
      // Se existe mas é outro tipo, remover e recriar
      accessory.removeService(energyService);
      energyService = accessory.addService(Service.Outlet, 'Produção Solar', 'energy-meter');
    }

    // Configurações do medidor de energia elétrica
    energyService
      .setCharacteristic(Characteristic.Name, `${name} - Energia Hoje`);

    // ⚡ Energia total consumida/gerada (hoje em kWh)
    if (!energyService.testCharacteristic(Characteristic.TotalConsumption)) {
      energyService.addCharacteristic(Characteristic.TotalConsumption);
    }

    // 🔌 Potência atual instantânea (W)
    if (!energyService.testCharacteristic(Characteristic.CurrentPowerConsumption)) {
      energyService.addCharacteristic(Characteristic.CurrentPowerConsumption);
    }

    // 📆 Status de produção (ativo/inativo)
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

    this.log.info(`⏰ Iniciando monitoramento contínuo de energia: ${name} (Plant ID: ${plantId})`);

    const updateData = async () => {
      try {
        // ESTA é a chamada que roda a cada 5 minutos - só busca dados do inversor específico
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
            
            // 📆 Voltagem da rede (220V padrão brasileiro)
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
          this.log.warn(`⚠️ ${name}: Dados inválidos recebidos da API de monitoramento`);
          if (response.data.error_msg) {
            this.log.warn(`⚠️ ${name}: API Error: ${response.data.error_msg}`);
          }
          this.handleOfflineStatus(accessory);
        }
      } catch (error) {
        // Para erros de monitoramento individual, não paramos tudo - só logamos
        if (error.message.includes('frequently_access')) {
          this.log.warn(`⏳ ${name}: Rate limit no monitoramento - aguardando próximo ciclo`);
        } else {
          this.log.error(`❌ ${name}: Erro no monitoramento individual - ${error.message}`);
        }
        this.handleOfflineStatus(accessory);
      }
    };

    // Primeira atualização em 10 segundos (dar tempo para a descoberta completar)
    setTimeout(updateData, 10000);
    
    // Atualização periódica a cada intervalo configurado
    accessory.updateTimer = setInterval(updateData, this.refreshInterval);
    
    this.log.info(`🔄 ${name}: Monitoramento configurado - atualizações a cada ${this.refreshInterval / 1000 / 60} minutos`);
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
    if (accessory.context && accessory.context.plantId) {
      this.accessories.delete(accessory.context.plantId.toString());
      this.log.info(`🗑️ Acessório removido: ${accessory.context.plantName} (ID: ${accessory.context.plantId})`);
    }
  }
}