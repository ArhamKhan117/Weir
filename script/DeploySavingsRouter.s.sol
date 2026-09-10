// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {SavingsRouter} from "../src/SavingsRouter.sol";
import {ISavingsRouter} from "../src/interfaces/ISavingsRouter.sol";

/// @title DeploySavingsRouter
/// @notice Deploys the savings router to Monad Mainnet or Testnet, over the one savings vault
///         chosen for each asset there.
/// @dev Everything network-specific is a constant below, keyed by chain id, so a run can only ever
///      deploy the routes of the chain it is actually on, and `MONAD_CHAIN_ID` in the environment
///      must name that chain too. The router's constructor checks each vault's `asset()` against
///      its asset on chain, so a wrong pairing fails in the simulation, before anything is sent.
///      Independent of `Deploy`: the router knows nothing of the hub, and the hub nothing of it.
///
///      forge script script/DeploySavingsRouter.s.sol:DeploySavingsRouter --rpc-url monad --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
///
///      The address printed is the simulation's. Record the one in
///      `broadcast/DeploySavingsRouter.s.sol/<chainId>/run-latest.json`, with
///      `node --env-file=.env scripts/record-deployment.mjs DeploySavingsRouter`.
contract DeploySavingsRouter is Script {
    uint256 internal constant MAINNET = 143;
    uint256 internal constant TESTNET = 10143;

    address internal constant MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant MAINNET_AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;

    /// @dev The ERC-4626 savings vaults over USDC and over AUSD. Both answered `asset()` with the
    ///      asset above when checked on chain before this was written.
    address internal constant MAINNET_USDC_VAULT = 0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59;
    address internal constant MAINNET_AUSD_VAULT = 0xbe3E6d3F857812B4731677C88288D4F3afF8E9a1;

    /// @dev The Testnet stand-ins `Deploy` shipped: the test AUSD and its simulated savings vault.
    address internal constant TESTNET_TAUSD = 0xf3066908dABe11f2e72F6887D9943eeb621a0Eb9;
    address internal constant TESTNET_SAVINGS_VAULT = 0xe0cd535d298DAd5e228486a79A21176349825B8d;

    error WrongChain(uint256 configured, uint256 actual);
    error UnsupportedChain(uint256 chainId);

    function run() external returns (SavingsRouter router) {
        uint256 configured = vm.envUint("MONAD_CHAIN_ID");
        if (block.chainid != configured) revert WrongChain(configured, block.chainid);

        vm.startBroadcast();
        router = deploy();
        vm.stopBroadcast();

        console2.log("chain id     ", block.chainid);
        console2.log("SavingsRouter", address(router));
        ISavingsRouter.Route[] memory list = router.routes();
        for (uint256 i = 0; i < list.length; ++i) {
            console2.log("  asset", list[i].asset);
            console2.log("  vault", list[i].vault);
        }
    }

    /// @notice The router for the current chain, without broadcasting. Split from `run` so tests
    ///         can exercise it under any chain id.
    function deploy() public returns (SavingsRouter) {
        (address[] memory assets, address[] memory vaults) = routes();
        return new SavingsRouter(assets, vaults);
    }

    /// @notice The assets and their vaults for the current chain, in the order the router lists them.
    function routes() public view returns (address[] memory assets, address[] memory vaults) {
        if (block.chainid == MAINNET) {
            assets = new address[](2);
            vaults = new address[](2);
            (assets[0], vaults[0]) = (MAINNET_USDC, MAINNET_USDC_VAULT);
            (assets[1], vaults[1]) = (MAINNET_AUSD, MAINNET_AUSD_VAULT);
        } else if (block.chainid == TESTNET) {
            assets = new address[](1);
            vaults = new address[](1);
            (assets[0], vaults[0]) = (TESTNET_TAUSD, TESTNET_SAVINGS_VAULT);
        } else {
            revert UnsupportedChain(block.chainid);
        }
    }
}
