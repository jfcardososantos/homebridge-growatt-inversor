# Homebridge Growatt Solar

Um plugin para Homebridge que integra inversores solares Growatt com o Apple HomeKit.

## Funcionalidades

- ✅ Monitore a potência atual do seu sistema solar
- ✅ Acompanhe a produção de energia do dia
- ✅ Verifique o status online/offline do inversor
- ✅ Suporte a múltiplas plantas
- ✅ Interface de configuração via Homebridge UI

## Instalação

### Via Homebridge UI (Recomendado)

1. Acesse a interface web do Homebridge
2. Vá para "Plugins"
3. Busque por "homebridge-growatt-solar"
4. Clique em "Instalar"

### Via linha de comando

```bash
npm install -g homebridge-growatt-solar
```

## Configuração

### Obtendo o Token da API

1. Acesse o portal de desenvolvedor da Growatt
2. Faça login com sua conta
3. Gere um token de API
4. Copie o token para usar na configuração

### Configuração via Homebridge UI

1. Vá para "Plugins" → "Growatt Solar" → "Settings"
2. Insira seu token da API Growatt
3. Configure o intervalo de atualização (padrão: 5 minutos)
4. Salve a configuração

### Configuração Manual (config.json)

```json
{
  "platforms": [
    {
      "name": "Growatt Solar",
      "platform": "GrowattSolar",
      "token": "seu_token_aqui",
      "refreshInterval": 5
    }
  ]
}
```

## Parâmetros de Configuração

| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|-----------|------|-------------|---------|-----------|
| `name` | string | Sim | "Growatt Solar" | Nome da plataforma |
| `token` | string | Sim | - | Token da API Growatt |
| `refreshInterval` | integer | Não | 5 | Intervalo de atualização em minutos |

## Como Funciona no HomeKit

O plugin cria os seguintes sensores para cada planta:

### Sensor de Potência Atual
- **Tipo**: Sensor de Luz
- **Função**: Mostra a potência atual em kW
- **Visualização**: Valor em "lux" (dividido por 10 para caber na escala)

### Sensor de Energia do Dia
- **Tipo**: Sensor de Umidade
- **Função**: Mostra a produção de energia do dia
- **Visualização**: Percentual baseado nos dados da planta

### Sensor de Status
- **Tipo**: Sensor de Contato
- **Função**: Indica se o inversor está online
- **Estados**: 
  - Fechado = Online
  - Aberto = Offline

## Solução de Problemas

### Plugin não aparece no HomeKit

1. Verifique se o token está correto
2. Confirme se há plantas associadas à sua conta Growatt
3. Verifique os logs do Homebridge para erros

### Dados não atualizam

1. Verifique sua conexão com a internet
2. Confirme se a API da Growatt está respondendo
3. Tente reduzir o intervalo de atualização

### Valores incorretos

1. Os valores são mapeados para funcionar com os tipos de sensor do HomeKit
2. A potência é dividida por 10 para caber na escala do sensor de luz
3. A energia do dia é convertida em percentual

## Logs de Debug

Para habilitar logs detalhados, configure o nível de log do Homebridge como "debug":

```json
{
  "bridge": {
    "name": "Homebridge",
    "username": "CC:22:3D:E3:CE:30",
    "port": 51826,
    "pin": "031-45-154"
  },
  "accessories": [],
  "platforms": [],
  "disabledPlugins": [],
  "ports": {
    "start": 52100,
    "end": 52150,
    "comment": "This section is used to control the range of ports that separate accessory (like camera or television) should be bind to."
  },
  "log": {
    "method": "systemd",
    "service": "homebridge",
    "level": "debug"
  }
}
```

## Contribuindo

1. Fork este repositório
2. Crie uma branch para sua feature (`git checkout -b feature/nova-funcionalidade`)
3. Commit suas mudanças (`git commit -am 'Adiciona nova funcionalidade'`)
4. Push para a branch (`git push origin feature/nova-funcionalidade`)
5. Abra um Pull Request

## Problemas Conhecidos

- Os valores são mapeados para tipos de sensor do HomeKit não ideais devido às limitações da API
- A atualização em tempo real pode ser limitada pela taxa de limite da API Growatt
- Alguns dados podem não estar disponíveis dependendo do modelo do inversor

## Changelog

### v1.0.0
- Lançamento inicial
- Suporte a múltiplas plantas
- Monitoramento de potência, energia e status
- Interface de configuração via Homebridge UI

## Licença

MIT

## Suporte

Se você encontrar problemas ou tiver sugestões:

1. Verifique os [Issues](https://github.com/jfcardososantos/homebridge-growatt-inversor/issues) existentes
2. Crie um novo issue com detalhes do problema
3. Inclua logs relevantes do Homebridge
