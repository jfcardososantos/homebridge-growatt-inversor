// Teste simples para verificar se o plugin carrega
console.log('=== TESTE PLUGIN GROWATT ===');

try {
  const plugin = require('./index.js');
  console.log('✅ Plugin carregou sem erros');
  
  // Mock básico do homebridge
  const mockHomebridge = {
    hap: {
      Characteristic: {},
      Service: {}
    },
    registerPlatform: (pluginName, platformName, constructor, dynamic) => {
      console.log(`✅ Platform registrada: ${platformName}, dynamic: ${dynamic}`);
    }
  };

  plugin(mockHomebridge);
  console.log('✅ Plugin executou sem erros');
  
} catch (error) {
  console.error('❌ Erro no plugin:', error.message);
  console.error(error.stack);
}