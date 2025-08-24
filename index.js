const axios = require('axios');

let hap, Characteristic, Service;

// ==================================================================================
//  MAIN PLUGIN EXPORT
// ==================================================================================

module.exports = (homebridge) => {
  hap = homebridge.hap;
  Characteristic = hap.Characteristic;
  Service = hap.Service;

  // Registra o plugin como um acessório único
  homebridge.registerAccessory('homebridge-growatt-inversor', 'GrowattInversor', GrowattInversorAccessory);
};

// ==================================================================================
//  ACCESSORY CLASS
// ==================================================================================

class GrowattInversorAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Inversor Solar';
    this.token = config.token;
    this.plantId = config.plant_id;
    this.refreshInterval = (config.refreshInterval || 5) * 60 * 1000; // Padrão 5 minutos

    // Validação da configuração
    if (!this.token || !this.plantId) {
      this.log.error('Token da API ou ID da Planta não configurados. Verifique suas configurações.');
      return;
    }

    this.log.info(`Inicializando acessório: ${this.name}`);

    // Armazenamento de estado
    this.state = {
      currentPower: 0,  // Potência atual em W
      todayEnergy: 0,   // Energia de hoje em kWh
      totalEnergy: 0,   // Energia total em kWh
      status: 'Offline' // 'Online' ou 'Offline'
    };

    // --- SERVIÇOS HOMEKIT ---

    // 1. Serviço de Informação do Acessório
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Growatt')
      .setCharacteristic(Characteristic.Model, 'Inversor Solar')
      .setCharacteristic(Characteristic.SerialNumber, this.plantId.toString());

    // 2. Sensor de Potência Atual (usando Sensor de Luz Ambiente)
    // A potência em Watts será o valor em Lux.
    this.powerService = new Service.LightSensor(`${this.name} - Potência`, 'power');
    this.powerService.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.state.currentPower)
      .setProps({ minValue: 0, maxValue: 100000 }); // Limite de 100kW

    // 3. Sensor de Energia do Dia (usando Sensor de Umidade)
    // A energia em kWh será o valor da umidade (%).
    this.todayEnergyService = new Service.HumiditySensor(`${this.name} - Energia Hoje`, 'today_energy');
    this.todayEnergyService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.state.todayEnergy)
      .setProps({ minValue: 0, maxValue: 1000 }); // Limite de 1000 kWh

    // 4. Sensor de Status (usando Sensor de Contato)
    this.statusService = new Service.ContactSensor(`${this.name} - Status`, 'status');
    this.statusService.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(() => this.state.status === 'Online' ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

    // Inicia o ciclo de atualizações
    this.startPeriodicUpdates();
  }

  /**
   * Inicia as chamadas periódicas à API da Growatt.
   */
  startPeriodicUpdates() {
    this.log.info(`Iniciando atualizações a cada ${this.refreshInterval / 60000} minutos.`);
    
    // Executa a primeira atualização logo após a inicialização
    setTimeout(() => this.updateData(), 1000);

    // Configura o intervalo para as próximas atualizações
    setInterval(() => this.updateData(), this.refreshInterval);
  }

  /**
   * Busca os dados mais recentes da API e atualiza os serviços HomeKit.
   */
  async updateData() {
    this.log.debug('Buscando dados do inversor...');

    try {
      const response = await axios.get(`https://openapi.growatt.com/v1/plant/data?plant_id=${this.plantId}`, {
        headers: { 'token': this.token },
        timeout: 10000 // Timeout de 10 segundos
      });

      if (response.data.error_code !== 0) {
        throw new Error(`API Error: ${response.data.error_msg} (Code: ${response.data.error_code})`);
      }

      const data = response.data.data;
      this.log.debug('Dados recebidos:', data);

      // Atualiza o estado interno
      // A API retorna 'current_power' em W, então não precisa de conversão.
      this.state.currentPower = parseFloat(data.current_power) || 0;
      this.state.todayEnergy = parseFloat(data.today_energy) || 0;
      this.state.totalEnergy = parseFloat(data.total_energy) || 0;
      this.state.status = this.state.currentPower > 0 ? 'Online' : 'Offline';

      // Atualiza os valores nos serviços HomeKit
      this.powerService.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, this.state.currentPower);
      this.todayEnergyService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, this.state.todayEnergy);
      this.statusService.updateCharacteristic(Characteristic.ContactSensorState, this.state.status === 'Online' ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

      this.log.info(`Dados atualizados: Potência: ${this.state.currentPower}W, Energia Hoje: ${this.state.todayEnergy}kWh, Status: ${this.state.status}`);

    } catch (error) {
      this.log.error('Falha ao buscar dados da Growatt:');
      if (error.response) {
        this.log.error(`- Status: ${error.response.status}`);
        this.log.error(`- Data: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log.error(`- Mensagem: ${error.message}`);
      }

      // Define um estado de erro
      this.state.status = 'Offline';
      this.statusService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }
  }

  /**
   * Retorna a lista de serviços que este acessório expõe.
   */
  getServices() {
    return [
      this.informationService,
      this.powerService,
      this.todayEnergyService,
      this.statusService
    ];
  }
}
