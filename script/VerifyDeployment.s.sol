// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MandateHub} from "../src/MandateHub.sol";
import {MandateCharger} from "../src/MandateCharger.sol";
import {SavingsRouter} from "../src/SavingsRouter.sol";
import {ISavingsRouter} from "../src/interfaces/ISavingsRouter.sol";

/// @title VerifyDeployment
/// @notice Checks the recorded deployment against the chain, with no key and no transaction.
/// @dev Reads the entry `MONAD_CHAIN_ID` names in `packages/shared/src/deployments.json` and
///      refuses a chain with nothing recorded. Every address must hold code, the hub's accepted
///      assets and EIP-712 domain must match the record, the charger must point at the hub and at
///      the recorded forwarders, and the Testnet stand-ins must be what they claim. When the entry
///      names a savings router, its routes on chain must be exactly the recorded `savings` map,
///      each over an asset the hub accepts and a vault whose `asset()` is that asset.
///
///      forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url monad
contract VerifyDeployment is Script {
    using stdJson for string;

    string internal constant RECORD = "packages/shared/src/deployments.json";

    error WrongChain(uint256 configured, uint256 actual);
    error NothingRecorded(uint256 chainId);
    error Mismatch(string what);

    function run() external view {
        uint256 chainId = vm.envUint("MONAD_CHAIN_ID");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);

        string memory json = vm.readFile(RECORD);
        string memory key = string.concat(".networks.", vm.toString(chainId));
        if (!vm.keyExistsJson(json, key)) revert NothingRecorded(chainId);

        MandateHub hub = MandateHub(json.readAddress(string.concat(key, ".contracts.MandateHub")));
        MandateCharger charger = MandateCharger(json.readAddress(string.concat(key, ".contracts.MandateCharger")));
        _hasCode(address(hub), "MandateHub");
        _hasCode(address(charger), "MandateCharger");

        (, string memory name, string memory version, uint256 domainChain, address verifying,,) = hub.eip712Domain();
        _check(_same(name, json.readString(string.concat(key, ".eip712.name"))), "EIP-712 name");
        _check(_same(version, json.readString(string.concat(key, ".eip712.version"))), "EIP-712 version");
        _check(domainChain == chainId && verifying == address(hub), "EIP-712 chain and contract");

        address[] memory assets = hub.acceptedAssets();
        string[] memory symbols = vm.parseJsonKeys(json, string.concat(key, ".assets"));
        _check(assets.length == symbols.length, "asset count");
        for (uint256 i = 0; i < assets.length; ++i) {
            string memory symbol = IERC20Metadata(assets[i]).symbol();
            _check(json.readAddress(string.concat(key, ".assets.", symbol)) == assets[i], "asset address");
            _check(IERC20Metadata(assets[i]).decimals() == 6, "asset decimals");
        }

        _check(address(charger.HUB()) == address(hub), "charger hub");
        _check(charger.FORWARDER() == json.readAddress(string.concat(key, ".chainlink.forwarder")), "forwarder");
        _check(
            charger.SIMULATION_FORWARDER() == json.readAddress(string.concat(key, ".chainlink.simulationForwarder")),
            "simulation forwarder"
        );

        if (chainId == 10143) {
            address stablecoin = json.readAddress(string.concat(key, ".contracts.TestStablecoin"));
            address savings = json.readAddress(string.concat(key, ".contracts.TestSavingsVault"));
            _hasCode(stablecoin, "TestStablecoin");
            _hasCode(savings, "TestSavingsVault");
            _check(hub.isAcceptedAsset(stablecoin), "test stablecoin accepted");
            _check(IERC4626(savings).asset() == stablecoin, "savings vault asset");
        } else {
            _check(!vm.keyExistsJson(json, string.concat(key, ".contracts.TestStablecoin")), "no test token on Mainnet");
        }

        _verifySavings(json, key, hub);

        console2.log("deployment verified on chain", chainId);
        console2.log("MandateHub     ", address(hub));
        console2.log("MandateCharger ", address(charger));
        _logRouter(json, key);
        console2.log("next mandate id", hub.nextMandateId());
    }

    /// @dev With a router recorded, its routes on chain are exactly the recorded `savings` map,
    ///      keyed by the asset's symbol, and every route is over an asset the hub accepts under that
    ///      same symbol and a vault whose `asset()` is that asset. Without one, there is no map.
    function _verifySavings(string memory json, string memory key, MandateHub hub) internal view {
        string memory routerKey = string.concat(key, ".contracts.SavingsRouter");
        string memory savingsKey = string.concat(key, ".savings");
        if (!vm.keyExistsJson(json, routerKey)) {
            _check(!vm.keyExistsJson(json, savingsKey), "no savings map without a router");
            return;
        }

        SavingsRouter router = SavingsRouter(json.readAddress(routerKey));
        _hasCode(address(router), "SavingsRouter");
        _check(vm.keyExistsJson(json, savingsKey), "savings map recorded");

        ISavingsRouter.Route[] memory routes = router.routes();
        _check(routes.length == vm.parseJsonKeys(json, savingsKey).length, "savings route count");
        for (uint256 i = 0; i < routes.length; ++i) {
            _verifyRoute(json, key, routes[i], router, hub);
        }
    }

    function _verifyRoute(
        string memory json,
        string memory key,
        ISavingsRouter.Route memory route,
        SavingsRouter router,
        MandateHub hub
    ) internal view {
        string memory symbol = IERC20Metadata(route.asset).symbol();
        _check(_records(json, string.concat(key, ".assets.", symbol), route.asset), "savings asset");
        _check(hub.isAcceptedAsset(route.asset), "savings asset accepted by the hub");
        _check(_records(json, string.concat(key, ".savings.", symbol), route.vault), "savings vault");
        _hasCode(route.vault, "savings vault");
        _check(IERC4626(route.vault).asset() == route.asset, "savings vault asset");
        _check(router.vaultFor(route.asset) == route.vault, "router vaultFor");
    }

    /// @dev Whether the record holds exactly `expected` at `path`.
    function _records(string memory json, string memory path, address expected) internal view returns (bool) {
        return vm.keyExistsJson(json, path) && json.readAddress(path) == expected;
    }

    function _logRouter(string memory json, string memory key) internal view {
        string memory routerKey = string.concat(key, ".contracts.SavingsRouter");
        if (vm.keyExistsJson(json, routerKey)) console2.log("SavingsRouter  ", json.readAddress(routerKey));
    }

    function _hasCode(address target, string memory what) internal view {
        if (target.code.length == 0) revert Mismatch(string.concat(what, " has no code"));
    }

    function _check(bool ok, string memory what) internal pure {
        if (!ok) revert Mismatch(what);
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
