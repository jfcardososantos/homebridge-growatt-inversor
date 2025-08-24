const axios = require('axios');
const NodeGeocoder = require('node-geocoder');

let hap, Characteristic, Service;

module.exports = (homebridge) => {
  hap = homebridge.hap;
  Characteristic = hap.Characteristic;
  Service = hap.Service;
  
  homebridge.registerPlatform('homebridge-growatt-inversor', 'GrowattSolar', GrowattSolarPlatform);
};

class GrowattSolarPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    
    this.accessories = [];
    this.token = config.token;
    this.refreshInterval = (config.refreshInterval || 5) * 60 * 1000; // Default 5 minutos
    this.useGeocodedNames = config.useGeocodedNames !== false; // Default true
    this.geocodingProvider = config.geocodingProvider || 'nominatim';
    this.googleApiKey = config.googleApiKey;
    
    if (!this.token) {
      this.log.error('⚠️  Token da API Growatt não configurado!');
      this.log.error('💡 Configure o token através da interface do Homebridge UI.');
      return;
    }
    
    // Configurar geocodificador se habilitado
    if (this.useGeocodedNames) {
      this.setupGeocoder();
    }
    
    this.log.info('🌞 Inicializando plugin Growatt Solar...');
    
    this.api.on('didFinishLaunching', () => {
      this.showWelcomeMessage();
      this.discoverDevices();
    });
  }
  
  setupGeocoder() {
    const geocoderOptions = {
      provider: this.geocodingProvider,
      httpAdapter: 'https',
      formatter: null
    };
    
    if (this.geocodingProvider === 'google' && this.googleApiKey) {
      geocoderOptions.apiKey = this.googleApiKey;
    }
    
    try {
      this.geocoder = NodeGeocoder(geocoderOptions);
      this.log.info(`🗺️  Geocodificador configurado: ${this.geocodingProvider}`);
    } catch (error) {
      this.log.warn('⚠️  Erro ao configurar geocodificador:', error.message);
      this.log.warn('📍 Será usado o nome original das plantas');
      this.useGeocodedNames = false;
    }
  }
  
  showWelcomeMessage() {
    this.log.info('');
    this.log.info('🎉 ============================================');
    this.log.info('🌞      GROWATT SOLAR PLUGIN ATIVO!        ');
    this.log.info('🎉 ============================================');
    this.log.info('📱 Seus dados solares aparecerão no app Casa');
    this.log.info('⚡ Monitoramento em tempo real ativado');
    this.log.info(`🔄 Atualização a cada ${this.config.refreshInterval || 5} minutos`);
    if (this.useGeocodedNames) {
      this.log.info('📍 Nomes baseados em localização: ATIVADO');
    }
    this.log.info('============================================');
    this.log.info('');
  }
  
  async discoverDevices() {
    try {
      this.log.info('🔍 Buscando plantas Growatt...');
      
      const plants = await this.getPlantList();
      
      if (plants.length === 0) {
        this.log.warn('⚠️  Nenhuma planta encontrada na sua conta Growatt');
        this.log.warn('💡 Verifique se o token está correto e se há plantas associadas');
        return;
      }
      
      this.log.info(`✅ Encontradas ${plants.length} planta(s)`);
      
      for (const plant of plants) {
        try {
          // Obter dados detalhados da planta
          const plantDetails = await this.getPlantDetails(plant.id);
          
          // Determinar nome da planta
          let displayName = await this.getPlantDisplayName(plant, plantDetails);
          
          this.log.info(`🌱 Configurando planta: "${displayName}" (ID: ${plant.id})`);
          
          const accessory = new GrowattSolarAccessory(this.log, {
            ...this.config,
            plantId: plant.id,
            plantName: displayName,
            originalPlantName: plant.plantName,
            token: this.token,
            plantDetails: plantDetails
          });
          
          this.accessories.push(accessory);
        } catch (error) {
          this.log.error(`❌ Erro ao configurar planta ${plant.plantName}:`, error.message);
        }
      }
      
      this.log.info(`🎯 Total de ${this.accessories.length} planta(s) configurada(s) com sucesso!`);
      
    } catch (error) {
      this.log.error('❌ Erro ao descobrir dispositivos:', error.message);
      if (error.response && error.response.status === 401) {
        this.log.error('🔑 Token inválido! Verifique sua configuração.');
      }
    }
  }
  
  async getPlantDisplayName(plant, plantDetails) {
    let displayName = plant.plantName || `Planta Solar ${plant.id}`;
    
    if (!this.useGeocodedNames || !this.geocoder) {
      return displayName;
    }
    
    try {
      // Tentar obter coordenadas dos detalhes da planta
      const latitude = plantDetails?.latitude || plantDetails?.lat;
      const longitude = plantDetails?.longitude || plantDetails?.lng || plantDetails?.lon;
      
      if (latitude && longitude) {
        this.log.debug(`📍 Geocodificando coordenadas: ${latitude}, ${longitude}`);
        
        const geocodeResult = await this.geocoder.reverse({
          lat: parseFloat(latitude),
          lon: parseFloat(longitude)
        });
        
        if (geocodeResult && geocodeResult.length > 0) {
          const address = geocodeResult[0];
          
          // Criar nome baseado no endereço
          const streetName = address.streetName;
          const streetNumber = address.streetNumber;
          const neighborhood = address.neighbourhood || address.suburb;
          const city = address.city;
          
          if (streetName) {
            if (streetNumber) {
              displayName = `Solar ${streetName}, ${streetNumber}`;
            } else if (neighborhood) {
              displayName = `Solar ${streetName} - ${neighborhood}`;
            } else {
              displayName = `Solar ${streetName}`;
            }
          } else if (neighborhood) {
            displayName = `Solar ${neighborhood}`;
          } else if (city) {
            displayName = `Solar ${city}`;
          }
          
          this.log.info(`📍 Nome baseado em localização: "${displayName}"`);
        }
      } else {
        this.log.debug('⚠️  Coordenadas não encontradas para geocodificação');
      }
    } catch (error) {
      this.log.warn('⚠️  Erro na geocodificação:', error.message);
      this.log.debug('📍 Usando nome original da planta');
    }
    
    return displayName;
  }
  
  async getPlantList() {
    try {
      const response = await axios.get('https://openapi.growatt.com/v1/plant/list', {
        headers: {
          'token': this.token
        }
      });
      
      if (response.data && response.data.data) {
        return response.data.data;
      }
      
      return [];
    } catch (error) {
      this.log.error('❌ Erro ao buscar lista de plantas:', error.message);
      throw error;
    }
  }
  
  async getPlantDetails(plantId) {
    try {
      const response = await axios.get(`https://openapi.growatt.com/v1/plant/details?plant_id=${plantId}`, {
        headers: {
          'token': this.token
        }
      });
      
      return response.data?.data || {};
    } catch (error) {
      this.log.warn(`⚠️  Erro ao obter detalhes da planta ${plantId}:`, error.message);
      return {};
    }
  }
  
  configureAccessory(accessory) {
    // Este método é chamado para acessórios em cache
    this.accessories.push(accessory);
  }
  
  accessories() {
    return this.accessories;
  }
}

class GrowattSolarAccessory {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.name = config.plantName || 'Growatt Solar';
    this.token = config.token;
    this.plantId = config.plantId;
    this.refreshInterval = (config.refreshInterval || 5) * 60 * 1000;
    this.plantDetails = config.plantDetails || {};
    
    // Dados atuais
    this.currentPower = 0;
    this.todayEnergy = 0;
    this.totalEnergy = 0;
    this.status = 'Offline';
    this.lastUpdate = new Date();
    
    // Configurar informações do acessório
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Solar Inverter')
      .setCharacteristic(Characteristic.SerialNumber, this.plantId.toString())
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');
    
    // Sensor de potência atual (usando Light Sensor)
    this.currentPowerService = new Service.LightSensor(`${this.name} - Potência`, 'current-power');
    this.currentPowerService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .onGet(this.getCurrentPower.bind(this))
      .setProps({
        minValue: 0.0001,
        maxValue: 100000
      });
    
    // Adicionar característica customizada para mostrar valor real
    this.currentPowerService
      .addCharacteristic(new Characteristic.Name())
      .onGet(() => `Potência: ${this.currentPower.toFixed(2)} kW`);
    
    // Sensor de energia do dia (usando Humidity Sensor)
    this.todayEnergyService = new Service.HumiditySensor(`${this.name} - Energia Hoje`, 'today-energy');
    this.todayEnergyService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(this.getTodayEnergy.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100
      });
    
    // Sensor de status (usando Contact Sensor)
    this.statusService = new Service.ContactSensor(`${this.name} - Status`, 'status');
    this.statusService
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(this.getStatus.bind(this));
    
    // Iniciar atualizações periódicas
    this.startPeriodicUpdates();
    
    this.log.info(`✅ Acessório criado: "${this.name}" (Plant ID: ${this.plantId})`);
  }
  
  async getCurrentPower() {
    // Converter potência para escala de lux (0.0001 a 100000)
    // Multiplicar por 10 para dar uma faixa melhor de valores
    const luxValue = Math.min(Math.max(this.currentPower * 10, 0.0001), 100000);
    return luxValue;
  }
  
  async getTodayEnergy() {
    // Converter energia do dia para percentual
    // Assumir que 100kWh = 100%
    const energyPercent = Math.min(Math.max(this.todayEnergy, 0), 100);
    return energyPercent;
  }
  
  async getStatus() {
    // Retorna status: 0 = Detectado/Online, 1 = Não detectado/Offline
    return this.status === 'Online' ? 0 : 1;
  }
  
  async updateData() {
    try {
      this.log.debug(`🔄 Atualizando dados da planta "${this.name}"...`);
      
      const response = await axios.get(`https://openapi.growatt.com/v1/plant/data?plant_id=${this.plantId}`, {
        headers: {
          'token': this.token
        }
      });
      
      if (response.data && response.data.data) {
        const data = response.data.data;
        
        // Mapear dados da API
        this.currentPower = parseFloat(data.current_power) || 0;
        this.todayEnergy = parseFloat(data.today_energy) || 0;
        this.totalEnergy = parseFloat(data.total_energy) || 0;
        
        // Determinar status baseado na potência atual e horário
        const currentHour = new Date().getHours();
        const isDayTime = currentHour >= 6 && currentHour <= 18;
        
        if (this.currentPower > 0) {
          this.status = 'Online';
        } else if (isDayTime && this.currentPower === 0) {
          this.status = 'Online'; // Pode estar online mas sem sol
        } else {
          this.status = 'Offline';
        }
        
        this.lastUpdate = new Date();
        
        // Atualizar características dos sensores
        this.currentPowerService
          .updateCharacteristic(Characteristic.CurrentAmbientLightLevel, await this.getCurrentPower());
        
        this.todayEnergyService
          .updateCharacteristic(Characteristic.CurrentRelativeHumidity, await this.getTodayEnergy());
        
        this.statusService
          .updateCharacteristic(Characteristic.ContactSensorState, await this.getStatus());
        
        this.log.debug(`📊 Dados atualizados - Potência: ${this.currentPower}kW, Energia: ${this.todayEnergy}kWh, Status: ${this.status}`);
        
      } else {
        throw new Error('Dados não recebidos da API');
      }
    } catch (error) {
      this.log.error(`❌ Erro ao atualizar dados da planta "${this.name}":`, error.message);
      
      // Em caso de erro, marcar como offline
      this.status = 'Offline';
      this.statusService
        .updateCharacteristic(Characteristic.ContactSensorState, 1);
      
      if (error.response) {
        if (error.response.status === 401) {
          this.log.error('🔑 Token inválido ou expirado');
        } else if (error.response.status === 429) {
          this.log.warn('⏱️  Limite de requisições atingido, reduzindo frequência');
        }
      }
    }
  }
  
  startPeriodicUpdates() {
    // Atualizar imediatamente
    setTimeout(() => {
      this.updateData();
    }, 2000); // Delay de 2s para evitar flood no startup
    
    // Configurar atualizações periódicas
    this.updateInterval = setInterval(() => {
      this.updateData();
    }, this.refreshInterval);
    
    this.log.info(`🔄 Atualizações automáticas configuradas a cada ${this.refreshInterval / 1000 / 60} minutos`);
  }
  
  getServices() {
    return [
      this.informationService,
      this.currentPowerService,
      this.todayEnergyService,
      this.statusService
    ];
  }
  
  // Método para limpeza quando o acessório é removido
  destroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.log.info(`🗑️  Limpeza do acessório "${this.name}" concluída`);
    }
  }
}