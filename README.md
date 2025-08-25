# Homebridge Growatt Inversor

Plugin para Homebridge que conecta seus inversores solares Growatt ao Apple HomeKit, permitindo monitorar dados de energia diretamente no app Casa.

## 🌟 Características

- **🔍 Descoberta automática** - Encontra todos os inversores da sua conta automaticamente
- **📊 Múltiplos inversores** - Suporta quantos inversores você tiver
- **🏠 Integração HomeKit** - Cada inversor aparece como um acessório separado
- **⏰ Atualização em tempo real** - Dados atualizados automaticamente
- **🌍 Interface em português** - Configuração e logs em português

## 📱 Como aparece no app Casa

Cada inversor aparece como um **botão grande** no app Casa com:

### 🔘 **Botão Principal (Medidor de Energia)**
- **Nome do inversor** como título do botão
- **Estado**: 🟢 Verde (produzindo) ou ⚫ Cinza (offline)
- **Ao tocar**: Abre detalhes com todas as informações

### 📊 **Detalhes no botão (características de energia):**
- **Potência Atual**: Watts sendo gerados agora
- **Energia Hoje**: kWh produzidos no dia (valor principal)
- **Voltagem**: 220V (simulado)
- **Status**: Se está em uso (produzindo energia)

### 📱 **Sensores Extras:**
- **Energia Total** - Total acumulado em kWh
- **Status Detalhado** - Sensor de contato para automações

## 🚀 Instalação

### Via Homebridge Config UI X (Recomendado)

1. Abra a interface web do Homebridge
2. Vá em **Plugins** → **Buscar**
3. Procure por `homebridge-growatt-inversor`
4. Clique em **Instalar**

### Via NPM

```bash
npm install -g homebridge-growatt-inversor
```

## ⚙️ Configuração

### 1. Obter Token da API Growatt

1. Acesse: https://openapi.growatt.com
2. Faça login com suas credenciais Growatt
3. Vá em **API Token**
4. Gere/copie seu token de acesso

### 2. Configurar no Homebridge

#### Via Interface Web:
1. Vá em **Plugins** → **Homebridge Growatt Inversor** → **Configurações**
2. Preencha apenas o **Token da API**
3. Salve e reinicie o Homebridge

#### Via config.json manual:
```json
{
  "platforms": [
    {
      "name": "Growatt Solar",
      "token": "seu_token_aqui",
      "refreshInterval": 5,
      "platform": "GrowattInversor"
    }
  ]
}
```

## 📋 Parâmetros de Configuração

| Parâmetro | Obrigatório | Padrão | Descrição |
|-----------|-------------|---------|-----------|
| `name` | ✅ | "Growatt Solar" | Nome da plataforma nos logs |
| `token` | ✅ | - | Token da API Growatt |
| `refreshInterval` | ❌ | 5 | Intervalo de atualização (minutos) |

## 🔧 Como funciona

1. **Descoberta**: O plugin usa seu token para buscar todos os inversores da conta via `/plant/list`
2. **Criação**: Cada inversor encontrado vira um acessório HomeKit separado
3. **Monitoramento**: Cada inversor é atualizado independentemente via `/plant/data`

## 📊 Exemplo de uso no HomeKit

### No app Casa você verá:

**Tela Principal:**
- Botão grande **"jfcardososantos"** (nome do seu inversor)
- Status: 🟢 **Ligado** (se produzindo) ou ⚫ **Desligado** (se offline)

**Ao tocar no botão:**
- **Potência**: 1500W (potência atual)
- **Energia**: 25.5 kWh (energia gerada hoje)
- **Voltagem**: 220V
- **Em uso**: Sim (se produzindo energia)

**Sensores extras:**
- **"Energia Total"**: 2847.3 kWh (total acumulado)
- **"Status Detalhado"**: Para automações

### 🤖 **Automações possíveis:**
- Notificação quando produção passa de X kWh no dia
- Alerta quando inversor fica offline por muito tempo  
- Comparar produção entre diferentes inversores
- Logs de produção diária/mensal

## 🐛 Resolução de Problemas

### Plugin não encontra inversores
- Verifique se o token está correto
- Confirme que sua conta Growatt tem inversores cadastrados
- Verifique os logs do Homebridge para erros de API

### Dados não atualizam
- Verifique sua conexão com a internet
- Confirme se a API da Growatt está funcionando
- Tente diminuir o `refreshInterval`

### Logs para debug
Ative logs de debug no Homebridge para ver detalhes:
```bash
homebridge -D
```

## 📝 Logs importantes

O plugin gera logs informativos:
- `🔍 Buscando inversores na conta...`
- `📊 Encontrados X inversor(es)`
- `✅ Nome do Inversor: 1500W, Hoje: 25.5kWh, Total: 2847.3kWh, Online`

## 🤝 Contribuição

Encontrou um bug ou tem uma sugestão? Abra uma issue no GitHub!

## 📄 Licença

MIT License - veja o arquivo [LICENSE](LICENSE) para detalhes.

## 🙏 Agradecimentos

- [Homebridge](https://homebridge.io/) - Plataforma incrível
- [Growatt](https://www.growatt.com/) - API para desenvolvedores
- Comunidade Homebridge - Suporte e feedback

---

**⚠️ Nota**: Este plugin não é oficial da Growatt. Use por sua conta e risco.