#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(message) {
  console.log(`🔧 [BUILD] ${message}`);
}

function executeCommand(command, description) {
  log(`${description}...`);
  try {
    execSync(command, { stdio: 'inherit' });
    log(`✅ ${description} concluído`);
  } catch (error) {
    log(`❌ Erro durante: ${description}`);
    process.exit(1);
  }
}

function main() {
  log('Iniciando processo de build...');

  // 1. Limpar pasta dist
  if (fs.existsSync('dist')) {
    executeCommand('rm -rf dist', 'Limpando pasta dist');
  }

  // 2. Verificar se existe src/
  if (!fs.existsSync('src')) {
    log('❌ Pasta src/ não encontrada!');
    process.exit(1);
  }

  // 3. Compilar TypeScript
  executeCommand('npx tsc', 'Compilando TypeScript');

  // 4. Verificar se os arquivos foram criados
  const indexPath = path.join('dist', 'index.js');
  const routesPath = path.join('dist', 'routes.js');

  if (!fs.existsSync(indexPath)) {
    log(`❌ Arquivo ${indexPath} não foi criado!`);
    process.exit(1);
  }

  if (!fs.existsSync(routesPath)) {
    log(`❌ Arquivo ${routesPath} não foi criado!`);
    process.exit(1);
  }

  // 5. Mostrar arquivos criados
  log('📁 Arquivos criados na pasta dist:');
  const distFiles = fs.readdirSync('dist');
  distFiles.forEach(file => {
    log(`   - ${file}`);
  });

  log('🎉 Build concluído com sucesso!');
}

main();