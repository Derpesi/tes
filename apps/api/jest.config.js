module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // Beberapa dependency (otplib -> @scure/@noble) hanya menyediakan ESM; Jest (CommonJS) perlu mentransformasinya.
  transform: { '^.+\\.[jt]s$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  transformIgnorePatterns: ['/node_modules/(?!.*(@scure|@noble)/)'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
