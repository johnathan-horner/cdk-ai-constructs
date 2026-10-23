// Test setup file for Jest
// This file is executed before each test suite

// Mock AWS SDK calls to avoid actual AWS API calls during testing
// Note: CDK v2 doesn't require aws-sdk mocking for template testing

// Set default timeout for tests
jest.setTimeout(30000);

// Global test setup
beforeAll(async () => {
  // Any global setup logic can go here
});

// Global test teardown
afterAll(async () => {
  // Any global cleanup logic can go here
});