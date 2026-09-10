// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MandateHub} from "../src/MandateHub.sol";
import {MandateCharger} from "../src/MandateCharger.sol";
import {TestStablecoin} from "../src/testnet/TestStablecoin.sol";
import {TestSavingsVault} from "../src/testnet/TestSavingsVault.sol";

/// @title Deploy
/// @notice Deploys the hub and the batch charger to Monad Mainnet or Testnet, and on Testnet a
///         test stablecoin standing in for the one that has no Testnet deployment, plus a savings
///         vault over it with a simulated rate, since Testnet has no real yield to draw from.
/// @dev Everything network-specific is a constant below, keyed by chain id, so a run can only ever
///      deploy the configuration of the chain it is actually on. `MONAD_CHAIN_ID` in the
///      environment must name that chain too, which is what stops a Mainnet `.env` from being run
///      against Testnet or the reverse.
///
///      forge script script/Deploy.s.sol:Deploy --rpc-url monad --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
///
///      A Testnet redeploy can keep the test token and savings vault already there, which the
///      savings router and every payer's balance live on: set `REUSE_TEST_STABLECOIN` and
///      `REUSE_TEST_SAVINGS_VAULT` to them, both or neither. Each is checked on chain to be the
///      stand-in it claims to be before anything is deployed over it.
///
///      The addresses printed are the simulation's. They match the broadcast only while the
///      deployer's nonce does not move in between; record the ones in
///      `broadcast/Deploy.s.sol/<chainId>/run-latest.json`.
contract Deploy is Script {
    uint256 internal constant MAINNET = 143;
    uint256 internal constant TESTNET = 10143;

    address internal constant MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant MAINNET_AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    /// @dev Chainlink CRE forwarders: `KeystoneForwarder` for deployed workflows, and the
    ///      `MockKeystoneForwarder` the simulator writes through.
    address internal constant MAINNET_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant MAINNET_SIMULATION_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant TESTNET_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    address internal constant TESTNET_SIMULATION_FORWARDER = 0xB9F79d863261869B234c481D1f9A7af84AeAd192;

    /// @notice EIP-712 domain version of this deployment.
    string public constant VERSION = "1";

    /// @dev What the Testnet stand-ins are constructed with, and so what a reused one must answer.
    string internal constant TEST_STABLECOIN_NAME = "Test AUSD";
    string internal constant TEST_STABLECOIN_SYMBOL = "tAUSD";
    string internal constant TEST_SAVINGS_NAME = "Test AUSD Savings";
    string internal constant TEST_SAVINGS_SYMBOL = "stAUSD";

    struct Deployment {
        MandateHub hub;
        MandateCharger charger;
        /// @dev Testnet only; zero on Mainnet. Deployed by this run, or reused.
        TestStablecoin testStablecoin;
        /// @dev Testnet only; zero on Mainnet. Deployed by this run, or reused.
        TestSavingsVault testSavingsVault;
    }

    /// @notice Testnet stand-ins already deployed, to build on instead of deploying new ones.
    ///         Both zero means deploy new ones.
    struct Reuse {
        address testStablecoin;
        address testSavingsVault;
    }

    error WrongChain(uint256 configured, uint256 actual);
    error UnsupportedChain(uint256 chainId);
    /// @notice Only one of the two stand-ins was named for reuse.
    error IncompleteReuse(address testStablecoin, address testSavingsVault);
    /// @notice A stand-in was named for reuse on a chain that has none.
    error ReuseIsTestnetOnly(uint256 chainId);
    /// @notice An address named for reuse is not the stand-in it should be.
    error NotReusable(address target, string what);

    function run() external returns (Deployment memory deployment) {
        uint256 configured = vm.envUint("MONAD_CHAIN_ID");
        if (block.chainid != configured) revert WrongChain(configured, block.chainid);
        string memory name = vm.envString("EIP712_NAME");
        Reuse memory reuse = Reuse({
            testStablecoin: vm.envOr("REUSE_TEST_STABLECOIN", address(0)),
            testSavingsVault: vm.envOr("REUSE_TEST_SAVINGS_VAULT", address(0))
        });

        vm.startBroadcast();
        deployment = deploy(name, reuse);
        vm.stopBroadcast();

        bool reused = reuse.testStablecoin != address(0);
        console2.log("chain id        ", block.chainid);
        console2.log("MandateHub      ", address(deployment.hub));
        console2.log("MandateCharger  ", address(deployment.charger));
        console2.log(reused ? "TestStablecoin   (reused)" : "TestStablecoin  ", address(deployment.testStablecoin));
        console2.log(reused ? "TestSavingsVault (reused)" : "TestSavingsVault", address(deployment.testSavingsVault));
    }

    /// @notice The deployment for the current chain with new Testnet stand-ins, without
    ///         broadcasting. Split from `run` so tests can exercise it under any chain id.
    function deploy(string memory name) public returns (Deployment memory) {
        return deploy(name, Reuse(address(0), address(0)));
    }

    /// @notice The deployment for the current chain, on Testnet over the stand-ins `reuse` names
    ///         when it names any, without broadcasting.
    function deploy(string memory name, Reuse memory reuse) public returns (Deployment memory deployment) {
        address[] memory assets = new address[](2);
        address forwarder;
        address simulationForwarder;
        bool reusing = reuse.testStablecoin != address(0) || reuse.testSavingsVault != address(0);
        if (reusing && block.chainid != TESTNET) revert ReuseIsTestnetOnly(block.chainid);

        if (block.chainid == MAINNET) {
            assets[0] = MAINNET_USDC;
            assets[1] = MAINNET_AUSD;
            forwarder = MAINNET_FORWARDER;
            simulationForwarder = MAINNET_SIMULATION_FORWARDER;
        } else if (block.chainid == TESTNET) {
            if (reusing) {
                (deployment.testStablecoin, deployment.testSavingsVault) = _reusable(reuse);
            } else {
                deployment.testStablecoin = new TestStablecoin(TEST_STABLECOIN_NAME, TEST_STABLECOIN_SYMBOL);
                deployment.testSavingsVault =
                    new TestSavingsVault(deployment.testStablecoin, TEST_SAVINGS_NAME, TEST_SAVINGS_SYMBOL);
            }
            assets[0] = TESTNET_USDC;
            assets[1] = address(deployment.testStablecoin);
            forwarder = TESTNET_FORWARDER;
            simulationForwarder = TESTNET_SIMULATION_FORWARDER;
        } else {
            revert UnsupportedChain(block.chainid);
        }

        deployment.hub = new MandateHub(name, VERSION, assets);
        deployment.charger = new MandateCharger(deployment.hub, forwarder, simulationForwarder);
    }

    /// @dev The two stand-ins `reuse` names, once each answers the way only the one this script
    ///      deploys would: the test token's name, symbol, six decimals, faucet cap and permit
    ///      domain, and the savings vault's name, symbol, simulated rate, permit domain and
    ///      `asset()`, which must be that token. Anything else reverts before a transaction.
    function _reusable(Reuse memory reuse) internal view returns (TestStablecoin token, TestSavingsVault savings) {
        if (reuse.testStablecoin == address(0) || reuse.testSavingsVault == address(0)) {
            revert IncompleteReuse(reuse.testStablecoin, reuse.testSavingsVault);
        }
        token = TestStablecoin(reuse.testStablecoin);
        savings = TestSavingsVault(reuse.testSavingsVault);

        _checkIdentity(address(token), TEST_STABLECOIN_NAME, TEST_STABLECOIN_SYMBOL, "test stablecoin");
        if (IERC20Metadata(address(token)).decimals() != 6) revert NotReusable(address(token), "decimals");
        if (token.MAX_MINT() != 10_000e6) revert NotReusable(address(token), "faucet cap");

        _checkIdentity(address(savings), TEST_SAVINGS_NAME, TEST_SAVINGS_SYMBOL, "savings vault");
        if (savings.RATE_BPS() != 500) revert NotReusable(address(savings), "simulated rate");
        if (IERC4626(address(savings)).asset() != address(token)) revert NotReusable(address(savings), "asset");
    }

    /// @dev `target` holds code, answers `name` and `symbol`, and signs permits under an EIP-712
    ///      domain of that name, version "1", on this chain and at its own address.
    function _checkIdentity(address target, string memory name, string memory symbol, string memory what)
        internal
        view
    {
        if (target.code.length == 0) revert NotReusable(target, string.concat(what, " has no code"));
        if (!_same(IERC20Metadata(target).name(), name)) revert NotReusable(target, string.concat(what, " name"));
        if (!_same(IERC20Metadata(target).symbol(), symbol)) {
            revert NotReusable(target, string.concat(what, " symbol"));
        }

        (, string memory domainName, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(target).eip712Domain();
        if (!_same(domainName, name) || !_same(version, "1") || chainId != block.chainid || verifying != target) {
            revert NotReusable(target, string.concat(what, " permit domain"));
        }
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
