import { ethers } from 'ethers';

// EntryPoint v0.6 ABI for UserOperationEvent
const ENTRYPOINT_ABI = [
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
];

// Global registry to track active listeners per provider/contract
const activeListeners = new Map();
/**
 * Get or create a shared event listener for the contract
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {string} entryPointAddress - EntryPoint contract address
 * @returns {Object} Shared listener manager
 */
function getSharedListener(provider, entryPointAddress) {
  const key = `${provider.connection?.url || 'default'}-${entryPointAddress}`;
  
  if (!activeListeners.has(key)) {
    const contract = new ethers.Contract(entryPointAddress, ENTRYPOINT_ABI, provider);
    const pendingOperations = new Map();
    
    const eventListener = async (eventUserOpHash, sender, paymaster, nonce, success, actualGasCost, actualGasUsed, event) => {
      if (pendingOperations.has(eventUserOpHash)) {
        const { resolve, clearTimeout } = pendingOperations.get(eventUserOpHash);
        pendingOperations.delete(eventUserOpHash);

        clearTimeout(); // cancel the timeout timer

        resolve({
          success,
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          gasUsed: actualGasUsed.toString(),
          gasCost: actualGasCost.toString()
        });
      }
    };

    contract.on('UserOperationEvent', eventListener);

    const manager = {
      contract,
      eventListener,
      pendingOperations,
      addOperation: (userOpHash, resolve, reject, timeoutId) => {
        pendingOperations.set(userOpHash, {
          resolve,
          reject,
          clearTimeout: () => clearTimeout(timeoutId)
        });
      },
      removeOperation: (userOpHash) => {
        pendingOperations.delete(userOpHash);
      },
      cleanup: () => {
        contract.removeListener('UserOperationEvent', eventListener);
        activeListeners.delete(key);
      }
    };

    activeListeners.set(key, manager);
  }

  return activeListeners.get(key);
}

/**
 * Waits for a UserOperationEvent with the specified userOpHash (thread-safe for parallel operations)
 * @param {ethers.Provider} provider - Ethereum provider
 * @param {string} entryPointAddress - EntryPoint contract address
 * @param {string} userOpHash - The userOpHash to wait for
 * @param {number} timeoutMs - Timeout in milliseconds (default: 60000)
 * @returns {Promise<{success: boolean, txHash: string}>} Success status and transaction hash
 */
export async function waitForUserOperationEvent(provider, userOpHash,  entryPointAddress="0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const sharedListener = getSharedListener(provider, entryPointAddress);

    const timeout = setTimeout(() => {
      sharedListener.removeOperation(userOpHash);
      reject(new Error(`Timeout waiting for UserOperationEvent with userOpHash: ${userOpHash}`));
    }, timeoutMs);

    sharedListener.addOperation(userOpHash, resolve, reject, timeout);
  });
}

/**
 * Clean up all listeners (call this when your application shuts down)
 */
export function cleanupAllListeners() {
  for (const [, manager] of activeListeners.entries()) {
    manager.cleanup();
  }
  activeListeners.clear();
}

process.on('exit', cleanupAllListeners);
process.on('SIGINT', () => {
  cleanupAllListeners();
  process.exit();
});