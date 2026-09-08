// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Deploy} from "../../script/Deploy.s.sol";
import {DeploySavingsRouter} from "../../script/DeploySavingsRouter.s.sol";
import {SavingsRouter} from "../../src/SavingsRouter.sol";
import {TestStablecoin} from "../../src/testnet/TestStablecoin.sol";
import {TestSavingsVault} from "../../src/testnet/TestSavingsVault.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {SavingsStandIns} from "../helpers/SavingsStandIns.sol";

/// @title DeployTest
/// @notice The deploy script ships exactly the configuration of the chain it runs on, and nothing
///         on a chain it does not know. On Testnet it can build on the test token and savings vault
///         already deployed instead of new ones, and only on those.
/// @dev `run` reads environment variables, which are process-wide while Foundry runs every suite
///      and every test in parallel, so every `run` case of every script lives in the one test
///      below and runs in sequence. A second test that writes the environment, in any file, could
///      interleave with it.
contract DeployTest is SavingsStandIns {
    Deploy internal script;
    DeploySavingsRouter internal routerScript;

    function setUp() public {
        script = new Deploy();
        routerScript = new DeploySavingsRouter();
    }

    function test_mainnetChargesUsdcAndAusdWithNoTestToken() public {
        vm.chainId(143);
        Deploy.Deployment memory d = script.deploy("Weir");

        address[] memory assets = d.hub.acceptedAssets();
        assertEq(assets[0], 0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
        assertEq(assets[1], 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
        assertEq(address(d.testStablecoin), address(0));
        assertEq(address(d.testSavingsVault), address(0));
        assertEq(d.charger.FORWARDER(), 0x76c9cf548b4179F8901cda1f8623568b58215E62);
        assertEq(d.charger.SIMULATION_FORWARDER(), 0x9eF6468C5f37b976E57d52054c693269479A784d);
        assertEq(address(d.charger.HUB()), address(d.hub));
    }

    function test_testnetChargesUsdcAndTheTestToken() public {
        vm.chainId(10143);
        Deploy.Deployment memory d = script.deploy("Weir");

        address[] memory assets = d.hub.acceptedAssets();
        assertEq(assets[0], 0x534b2f3A21130d7a60830c2Df862319e593943A3);
        assertEq(assets[1], address(d.testStablecoin));
        assertEq(d.testStablecoin.decimals(), 6);
        assertEq(d.testStablecoin.symbol(), "tAUSD");
        assertEq(d.testSavingsVault.asset(), address(d.testStablecoin));
        assertEq(d.testSavingsVault.symbol(), "stAUSD");
        assertEq(d.charger.FORWARDER(), 0xF8344CFd5c43616a4366C34E3EEE75af79a74482);
        assertEq(d.charger.SIMULATION_FORWARDER(), 0xB9F79d863261869B234c481D1f9A7af84AeAd192);
    }

    function test_domainCarriesTheGivenName() public {
        vm.chainId(10143);
        Deploy.Deployment memory d = script.deploy("Some Name");

        (, string memory name, string memory version,,,,) = d.hub.eip712Domain();
        assertEq(name, "Some Name");
        assertEq(version, "1");
    }

    function test_refusesAnUnknownChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, 1));
        script.deploy("Weir");
    }

    /*//////////////////////////////////////////////////////////////
                              REUSED STAND-INS
    //////////////////////////////////////////////////////////////*/

    function test_testnetCanBuildOnTheStandInsAlreadyThere() public {
        vm.chainId(10143);
        (TestStablecoin token, TestSavingsVault savings) = _standIns();

        Deploy.Deployment memory d = script.deploy("Weir", Deploy.Reuse(address(token), address(savings)));

        assertEq(address(d.testStablecoin), address(token));
        assertEq(address(d.testSavingsVault), address(savings));
        address[] memory assets = d.hub.acceptedAssets();
        assertEq(assets[0], 0x534b2f3A21130d7a60830c2Df862319e593943A3);
        assertEq(assets[1], address(token));
        assertEq(address(d.charger.HUB()), address(d.hub));
    }

    function test_reusesBothStandInsOrNeither() public {
        vm.chainId(10143);
        (TestStablecoin token, TestSavingsVault savings) = _standIns();

        vm.expectRevert(abi.encodeWithSelector(Deploy.IncompleteReuse.selector, address(token), address(0)));
        script.deploy("Weir", Deploy.Reuse(address(token), address(0)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.IncompleteReuse.selector, address(0), address(savings)));
        script.deploy("Weir", Deploy.Reuse(address(0), address(savings)));
    }

    function test_reusesNothingOffTestnet() public {
        (TestStablecoin token, TestSavingsVault savings) = _standIns();
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(Deploy.ReuseIsTestnetOnly.selector, 143));
        script.deploy("Weir", Deploy.Reuse(address(token), address(savings)));
    }

    /// @dev Each check stands between a typo in the environment and a hub over the wrong token.
    function test_refusesToReuseAnythingButTheStandIns() public {
        vm.chainId(10143);
        (TestStablecoin token, TestSavingsVault savings) = _standIns();
        address nobody = makeAddr("nobody");

        _expectNotReusable(nobody, address(savings), nobody, "test stablecoin has no code");
        TestStablecoin renamed = new TestStablecoin("Test AUSD", "AUSD");
        _expectNotReusable(address(renamed), address(savings), address(renamed), "test stablecoin symbol");
        TestStablecoin other = new TestStablecoin("Other Dollar", "tAUSD");
        _expectNotReusable(address(other), address(savings), address(other), "test stablecoin name");

        _expectNotReusable(address(token), nobody, nobody, "savings vault has no code");
        MockVault plain = new MockVault(token);
        _expectNotReusable(address(token), address(plain), address(plain), "savings vault name");
        TestSavingsVault overAnother =
            new TestSavingsVault(new TestStablecoin("Test AUSD", "tAUSD"), "Test AUSD Savings", "stAUSD");
        _expectNotReusable(address(token), address(overAnother), address(overAnother), "asset");
        // The vault and the token swapped: each is refused for what it is not.
        _expectNotReusable(address(savings), address(token), address(savings), "test stablecoin name");
    }

    /// @dev A test token and savings vault built the way `Deploy` builds them, on this chain.
    function _standIns() internal returns (TestStablecoin token, TestSavingsVault savings) {
        token = new TestStablecoin("Test AUSD", "tAUSD");
        savings = new TestSavingsVault(token, "Test AUSD Savings", "stAUSD");
    }

    function _expectNotReusable(address token, address savings, address culprit, string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotReusable.selector, culprit, what));
        script.deploy("Weir", Deploy.Reuse(token, savings));
    }

    /// @dev Also the reuse opt-in, read from the environment: unset or zero deploys new
    ///      stand-ins, and naming the ones at the real Testnet addresses builds on them. Both are
    ///      written explicitly first, since Foundry loads the developer's `.env`, which may name
    ///      them.
    function test_runDeploysOnlyOnTheChainTheEnvironmentNames() public {
        vm.chainId(10143);
        vm.setEnv("EIP712_NAME", "Weir");
        standInTestnetAsDeployed();
        _setReuse(address(0), address(0));

        vm.setEnv("MONAD_CHAIN_ID", "143");
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 143, 10143));
        script.run();
        vm.expectRevert(abi.encodeWithSelector(DeploySavingsRouter.WrongChain.selector, 143, 10143));
        routerScript.run();

        vm.setEnv("MONAD_CHAIN_ID", "10143");
        Deploy.Deployment memory d = script.run();
        assertEq(d.hub.nextMandateId(), 1);
        assertTrue(address(d.testStablecoin) != TESTNET_TAUSD, "new stand-ins unless reuse is asked for");
        SavingsRouter router = routerScript.run();
        assertEq(router.vaultFor(TESTNET_TAUSD), TESTNET_SAVINGS_VAULT);

        _setReuse(TESTNET_TAUSD, TESTNET_SAVINGS_VAULT);
        d = script.run();
        assertEq(address(d.testStablecoin), TESTNET_TAUSD);
        assertEq(address(d.testSavingsVault), TESTNET_SAVINGS_VAULT);
        assertEq(d.hub.acceptedAssets()[1], TESTNET_TAUSD);
        assertTrue(d.hub.isAcceptedAsset(router.routes()[0].asset), "the router's asset is still accepted");

        _setReuse(TESTNET_TAUSD, address(0));
        vm.expectRevert(abi.encodeWithSelector(Deploy.IncompleteReuse.selector, TESTNET_TAUSD, address(0)));
        script.run();

        _setReuse(address(0), address(0));
    }

    function _setReuse(address token, address savings) internal {
        vm.setEnv("REUSE_TEST_STABLECOIN", vm.toString(token));
        vm.setEnv("REUSE_TEST_SAVINGS_VAULT", vm.toString(savings));
    }
}
