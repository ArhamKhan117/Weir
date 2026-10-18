// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {MandateMeter} from "../src/MandateMeter.sol";
import {IMandateHub} from "../src/interfaces/IMandateHub.sol";

/// @title DeployMandateMeter
/// @notice Deploys the meter to Monad Mainnet or Testnet, accepting exactly the assets the
///         network's recorded hub accepts, under the same EIP-712 name.
/// @dev Reads the hub from `packages/shared/src/deployments.json` and its assets from the hub on
///      chain, so the two can never disagree. Independent of the hub otherwise: the meter calls
///      nothing on it.
///
///      forge script script/DeployMandateMeter.s.sol:DeployMandateMeter --rpc-url monad --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
///
///      The address printed is the simulation's. Record the one in
///      `broadcast/DeployMandateMeter.s.sol/<chainId>/run-latest.json`, with
///      `node --env-file=.env scripts/record-deployment.mjs DeployMandateMeter`.
contract DeployMandateMeter is Script {
    error WrongChain(uint256 configured, uint256 actual);

    function run() external returns (MandateMeter meter) {
        uint256 configured = vm.envUint("MONAD_CHAIN_ID");
        if (block.chainid != configured) revert WrongChain(configured, block.chainid);

        string memory name = vm.envString("EIP712_NAME");
        address[] memory assets = IMandateHub(hubOf(block.chainid)).acceptedAssets();

        vm.startBroadcast();
        meter = new MandateMeter(name, "1", assets);
        vm.stopBroadcast();

        console2.log("chain id    ", block.chainid);
        console2.log("MandateMeter", address(meter));
        for (uint256 i = 0; i < assets.length; ++i) {
            console2.log("  asset", assets[i]);
        }
    }

    /// @notice The hub recorded for `chainId`.
    function hubOf(uint256 chainId) public view returns (address) {
        string memory record = vm.readFile(string.concat(vm.projectRoot(), "/packages/shared/src/deployments.json"));
        return vm.parseJsonAddress(record, string.concat(".networks.", vm.toString(chainId), ".contracts.MandateHub"));
    }
}
