
# Presence Protocol Smart Account and Smart Contract Management

This repository contains the implementation for managing smart accounts and deploying smart contracts using Biconomy's infrastructure, specifically designed for the Presence Protocol. It includes functionalities for creating, deploying, and managing smart contracts with gasless transactions.

## Table of Contents
- [Installation](#installation)
- [Usage](#usage)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [Contributing](#contributing)
- [License](#license)

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/ZeroCodeLabs-OU/account_abstraction.git
   cd account_abstraction
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

## Usage

1. Start the application:

   ```bash
   node app.js
   ```

2. Ensure you have the necessary environment variables set up (see below).

## Environment Variables

Create a `.env` file in the root directory and add the following environment variables:

```
INFURA_PROJECT_URL=your_infura_project_url
PAYMASTER_URL=your_paymaster_url
PAYMASTER_KEY=your_paymaster_key
BUNDLER_URL=your_bundler_url
```

Replace `your_infura_project_url`, `your_paymaster_url`, `your_paymaster_key`, and `your_bundler_url` with your actual credentials.

## API Endpoints

### Create Smart Account

- **URL**: `/createSmartAccount`
- **Method**: `POST`
- **Body Parameters**:
  - `encrypted_wallet` (object):
    - `encryptedData` (string): Encrypted wallet data.
    - `iv` (string): Initialization vector.
- **Response**: 
  - `201 Created`: Smart account created successfully.
  - `400 Bad Request`: Invalid encrypted wallet data.
  - `409 Conflict`: A smart account with this wallet address already exists.
  - `500 Internal Server Error`: Internal server error.

### Get Smart Account

- **URL**: `/getSmartAccount`
- **Method**: `POST`
- **Body Parameters**:
  - `wallet_address` (string): Wallet address to retrieve the smart account for.
- **Response**:
  - `200 OK`: Smart account retrieved successfully.
  - `404 Not Found`: Smart account not found.
  - `500 Internal Server Error`: Internal server error.

### Deploy Smart Contract

- **URL**: `/deploySmartContract`
- **Method**: `POST`
- **Body Parameters**:
  - `encrypted_wallet` (object):
    - `encryptedData` (string): Encrypted wallet data.
    - `iv` (string): Initialization vector.
  - `voucherId` (string): ID of the voucher.
  - `name` (string): Name of the contract.
  - `max_supply` (number): Maximum supply of tokens.
  - `tokenQuantity` (array): Array of token quantities.
  - `max_token_per_mint` (number): Maximum tokens per mint.
  - `max_token_per_person` (number): Maximum tokens per person.
- **Response**:
  - `200 OK`: Contract deployed and initialized successfully.
  - `400 Bad Request`: Invalid encrypted wallet data.
  - `500 Internal Server Error`: Internal server error.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
