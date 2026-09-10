// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HubFixture} from "../helpers/HubFixture.sol";
import {IMandateHub} from "../../src/interfaces/IMandateHub.sol";
import {RefusingToken} from "../mocks/RefusingToken.sol";
import {MockVault} from "../mocks/MockVault.sol";

/// @title MandateHubRevertFuzzTest
/// @notice A reverting call changes nothing. Every way `charge`, `cancelMandate`, `pauseMandate`,
///         `resumeMandate` and `setManager` can revert is set up from fuzzed state and callers, and
///         afterwards every mandate record (through the getter and as raw storage words), every
///         balance, allowance and supply of every asset and of the vault's shares, and
///         `nextMandateId` are byte-for-byte what they were. A vault that cannot pay is not among
///         them: a charge drawn from one falls back to the payer's balance or fails without
///         reverting, which `MandateHubVaultFuzzTest` covers. A final test reaches arbitrary states
///         by random walks, vault-backed streams and vault failure modes included, and checks the
///         same for whichever of the five calls reverts there.
contract MandateHubRevertFuzzTest is HubFixture {
    /// @dev Storage slots of `nextMandateId` and `_mandates`, pinned against the getters in
    ///      `setUp` so a layout change fails loudly instead of snapshotting the wrong words.
    uint256 internal constant NEXT_ID_SLOT = 2;
    uint256 internal constant MANDATES_SLOT = 3;

    /// @dev Six storage words per mandate record, the vault alone in the last.
    uint256 internal constant RECORD_WORDS = 6;

    /// @dev A vault over `usd` the payer saves in and has approved the hub on.
    MockVault internal vault;

    function setUp() public override {
        super.setUp();

        // Savings on top of the fixture's wallet, which stays exactly as funded and approved.
        vault = new MockVault(usd);
        deal(address(usd), payer, usd.balanceOf(payer) + 500 * uint256(DOLLAR));
        vm.startPrank(payer);
        usd.approve(address(vault), 500 * uint256(DOLLAR));
        vault.deposit(500 * uint256(DOLLAR), payer);
        vault.approve(address(hub), type(uint256).max);
        vm.stopPrank();

        // Two bystander records, one drawn from the vault, that every snapshot also covers.
        uint256 id = create(monthly());
        uint256 saved = create(_fromVault(monthly()));
        assertEq(uint256(vm.load(address(hub), bytes32(NEXT_ID_SLOT))), hub.nextMandateId(), "nextMandateId slot");
        assertEq(address(uint160(uint256(vm.load(address(hub), _slot(id, 0))))), payer, "mandates slot");
        assertEq(address(uint160(uint256(vm.load(address(hub), _slot(saved, 5))))), address(vault), "vault word");
    }

    /*//////////////////////////////////////////////////////////////
                                 CHARGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Scenarios: 0 unknown id, 1 cancelled, 2 expired, 3 paused, 4 periodic not due,
    ///      5 stream not due, 6 periodic cap spent, 7 stream cap spent, 8 token returns false,
    ///      9 token reverts.
    function testFuzz_revertingChargeChangesNothing(
        uint256 scenario,
        bool streaming,
        uint256 seedA,
        uint256 seedB,
        address caller
    ) public {
        (uint256 id, bytes memory expected) = _arrangeChargeRevert(bound(scenario, 0, 9), streaming, seedA, seedB);
        _assertRevertsAndChangesNothing(_anyCaller(caller), abi.encodeCall(IMandateHub.charge, (id)), expected);
    }

    /*//////////////////////////////////////////////////////////////
                                 CANCEL
    //////////////////////////////////////////////////////////////*/

    /// @dev Scenarios: 0 unknown id, 1 caller is none of payer, merchant or manager (including the
    ///      zero address against a mandate with no manager), 2 already cancelled.
    function testFuzz_revertingCancelChangesNothing(uint256 scenario, bool streaming, uint256 seed, address caller)
        public
    {
        scenario = bound(scenario, 0, 2);
        uint256 id;
        bytes memory expected;

        if (scenario == 0) {
            (id, expected) = _unknown(seed);
            caller = _anyCaller(caller);
        } else if (scenario == 1) {
            id = _openRunning(streaming, seed % 2 == 0, seed);
            // With no manager, the zero address must not pass for one.
            caller = seed % 4 == 0 ? address(0) : _outsider(caller, id);
            expected = abi.encodeWithSelector(IMandateHub.NotAuthorized.selector);
        } else {
            id = _openRunning(streaming, false, seed);
            vm.prank(_role(seed));
            hub.cancelMandate(id);
            vm.warp(block.timestamp + bound(seed >> 64, 0, 400 days));
            caller = _role(seed >> 128);
            expected = abi.encodeWithSelector(IMandateHub.MandateIsCancelled.selector);
        }

        _assertRevertsAndChangesNothing(caller, abi.encodeCall(IMandateHub.cancelMandate, (id)), expected);
    }

    /*//////////////////////////////////////////////////////////////
                              PAUSE, RESUME
    //////////////////////////////////////////////////////////////*/

    /// @dev Scenarios: 0 unknown id, 1 caller is neither payer nor manager (the merchant included),
    ///      2 cancelled, 3 expired, 4 periodic, 5 already paused.
    function testFuzz_revertingPauseChangesNothing(uint256 scenario, uint256 seed, address caller) public {
        (uint256 id, address by, bytes memory expected) =
            _arrangeStreamControlRevert(bound(scenario, 0, 5), true, seed, caller);
        _assertRevertsAndChangesNothing(by, abi.encodeCall(IMandateHub.pauseMandate, (id)), expected);
    }

    /// @dev Scenarios: 0 unknown id, 1 caller is neither payer nor manager (the merchant included),
    ///      2 cancelled while paused, 3 expired while paused, 4 periodic, 5 not paused.
    function testFuzz_revertingResumeChangesNothing(uint256 scenario, uint256 seed, address caller) public {
        (uint256 id, address by, bytes memory expected) =
            _arrangeStreamControlRevert(bound(scenario, 0, 5), false, seed, caller);
        _assertRevertsAndChangesNothing(by, abi.encodeCall(IMandateHub.resumeMandate, (id)), expected);
    }

    /*//////////////////////////////////////////////////////////////
                               SET MANAGER
    //////////////////////////////////////////////////////////////*/

    /// @dev Scenarios: 0 unknown id, 1 caller is not the payer (manager and merchant included),
    ///      2 cancelled.
    function testFuzz_revertingSetManagerChangesNothing(
        uint256 scenario,
        bool streaming,
        uint256 seed,
        address caller,
        address newManager
    ) public {
        scenario = bound(scenario, 0, 2);
        uint256 id;
        bytes memory expected;

        if (scenario == 0) {
            (id, expected) = _unknown(seed);
            caller = _anyCaller(caller);
        } else if (scenario == 1) {
            id = _openRunning(streaming, false, seed);
            uint256 pick = seed % 3;
            caller = pick == 0 ? manager : pick == 1 ? merchant : _outsider(caller, id);
            expected = abi.encodeWithSelector(IMandateHub.NotAuthorized.selector);
        } else {
            id = _openRunning(streaming, false, seed);
            vm.prank(_role(seed));
            hub.cancelMandate(id);
            caller = payer;
            expected = abi.encodeWithSelector(IMandateHub.MandateIsCancelled.selector);
        }

        _assertRevertsAndChangesNothing(caller, abi.encodeCall(IMandateHub.setManager, (id, newManager)), expected);
    }

    /*//////////////////////////////////////////////////////////////
                               RANDOM WALKS
    //////////////////////////////////////////////////////////////*/

    /// @dev Reaches arbitrary states by a random walk over the same five calls plus warps, funding
    ///      changes, token refusals, and the vault paying short, running short of liquidity,
    ///      switching to zero `max*` answers or losing its share allowance, then makes one more
    ///      call. Whenever that call reverts, nothing it could have touched has changed.
    function testFuzz_anyRevertingCallChangesNothing(uint256[12] memory steps, uint256 finalCall) public {
        uint256[4] memory ids = _walkWorld();
        for (uint256 i = 0; i < steps.length; ++i) {
            _walkStep(ids, steps[i]);
        }

        (address caller, bytes memory data) = _finalCall(ids, finalCall);
        bytes memory before = _snapshot(caller);
        vm.prank(caller);
        (bool ok,) = address(hub).call(data);

        if (!ok) assertEq(_snapshot(caller), before, "a reverting call changed state");
    }

    /*//////////////////////////////////////////////////////////////
                          CHARGE REVERT SCENARIOS
    //////////////////////////////////////////////////////////////*/

    function _arrangeChargeRevert(uint256 scenario, bool streaming, uint256 a, uint256 b)
        internal
        returns (uint256 id, bytes memory expected)
    {
        if (scenario == 0) return _unknown(a);
        if (scenario == 1) return _chargeCancelled(streaming, a, b);
        if (scenario == 2) return _chargeExpired(streaming, a);
        if (scenario == 3) return _chargePaused(a, b);
        if (scenario == 4) return _chargePeriodicNotDue(a);
        if (scenario == 5) return _chargeStreamNotDue(a);
        if (scenario == 6) return _chargePeriodicCapSpent(a);
        if (scenario == 7) return _chargeStreamCapSpent(a);
        if (scenario == 8) return _chargeRefused(streaming, RefusingToken.Mode.ReturnFalse, a);
        return _chargeRefused(streaming, RefusingToken.Mode.Revert, a);
    }

    function _chargeCancelled(bool streaming, uint256 a, uint256 b) internal returns (uint256 id, bytes memory) {
        id = _openRunning(streaming, false, a);
        vm.prank(_role(b));
        hub.cancelMandate(id);
        vm.warp(block.timestamp + bound(b >> 8, 0, 400 days));
        return (id, abi.encodeWithSelector(IMandateHub.MandateIsCancelled.selector));
    }

    function _chargeExpired(bool streaming, uint256 a) internal returns (uint256 id, bytes memory) {
        id = create(streaming ? perSecond() : monthly());
        uint64 expiresAt = hub.getMandate(id).expiresAt;
        vm.warp(uint256(expiresAt) + bound(a, 1, 3650 days));
        return (id, abi.encodeWithSelector(IMandateHub.MandateExpired.selector, expiresAt, block.timestamp));
    }

    function _chargePaused(uint256 a, uint256 b) internal returns (uint256 id, bytes memory) {
        id = _openRunning(true, false, a);
        vm.prank(b % 2 == 0 ? payer : manager);
        hub.pauseMandate(id);
        vm.warp(block.timestamp + bound(b >> 8, 0, 10 days));
        return (id, abi.encodeWithSelector(IMandateHub.MandateIsPaused.selector));
    }

    /// @dev Either charged in this period, or anchored in the future and not reached yet.
    function _chargePeriodicNotDue(uint256 a) internal returns (uint256 id, bytes memory) {
        if (a % 2 == 0) {
            id = create(monthly());
            hub.charge(id);
            vm.warp(block.timestamp + bound(a >> 8, 0, MONTH - 1));
        } else {
            IMandateHub.Terms memory t = monthly();
            t.startAt = uint64(block.timestamp + bound(a >> 8, 1, 300 days));
            id = create(t);
            vm.warp(block.timestamp + bound(a >> 128, 0, t.startAt - block.timestamp - 1));
        }
        return
            (id, abi.encodeWithSelector(IMandateHub.NotDue.selector, hub.getMandate(id).nextChargeAt, block.timestamp));
    }

    /// @dev At the creation block, right after a charge in the same second, or before a future start.
    function _chargeStreamNotDue(uint256 a) internal returns (uint256 id, bytes memory) {
        uint256 mode = a % 3;
        if (mode == 0) {
            id = create(perSecond());
        } else if (mode == 1) {
            id = create(perSecond());
            vm.warp(block.timestamp + bound(a >> 8, 1, 20 days));
            hub.charge(id);
        } else {
            IMandateHub.Terms memory t = perSecond();
            t.startAt = uint64(block.timestamp + bound(a >> 8, 1, 20 days));
            id = create(t);
            vm.warp(block.timestamp + bound(a >> 128, 0, t.startAt - block.timestamp));
        }
        return
            (id, abi.encodeWithSelector(IMandateHub.NotDue.selector, hub.getMandate(id).nextChargeAt, block.timestamp));
    }

    function _chargePeriodicCapSpent(uint256 a) internal returns (uint256 id, bytes memory) {
        uint256 charges = bound(a, 1, 6);
        IMandateHub.Terms memory t = monthly();
        t.maxTotal = uint96(t.amount * charges);
        id = create(t);
        for (uint256 i = 0; i < charges; ++i) {
            hub.charge(id);
            vm.warp(block.timestamp + MONTH);
        }
        return (id, abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, t.maxTotal, t.maxTotal));
    }

    function _chargeStreamCapSpent(uint256 a) internal returns (uint256 id, bytes memory) {
        IMandateHub.Terms memory t = perSecond();
        t.maxTotal = uint96(bound(a, 1, 20 * DOLLAR));
        id = create(t);
        while (hub.getMandate(id).totalCharged < t.maxTotal) {
            vm.warp(block.timestamp + 1 days);
            hub.charge(id);
        }
        vm.warp(block.timestamp + bound(a >> 128, 1, 1 days));
        return (id, abi.encodeWithSelector(IMandateHub.TotalCapExceeded.selector, t.maxTotal, t.maxTotal));
    }

    /// @dev Balance and allowance cover the charge, and the token still says no.
    function _chargeRefused(bool streaming, RefusingToken.Mode mode, uint256 a)
        internal
        returns (uint256 id, bytes memory)
    {
        IMandateHub.Terms memory t = streaming ? perSecond() : monthly();
        t.asset = address(refusing);
        id = create(t);
        if (streaming) vm.warp(block.timestamp + bound(a, 1, 20 days));
        refusing.setMode(mode);

        bytes memory expected = mode == RefusingToken.Mode.ReturnFalse
            ? abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(refusing))
            : abi.encodeWithSignature("Error(string)", "RefusingToken: refused");
        return (id, expected);
    }

    /// @dev Savings and share allowance cover the charge, and the vault withdraws for it but pays
    ///      the merchant one base unit short: the exact-receipt check must undo the withdrawal.
    /*//////////////////////////////////////////////////////////////
                      PAUSE AND RESUME REVERT SCENARIOS
    //////////////////////////////////////////////////////////////*/

    function _arrangeStreamControlRevert(uint256 scenario, bool pausing, uint256 seed, address caller)
        internal
        returns (uint256 id, address by, bytes memory expected)
    {
        by = seed % 2 == 0 ? payer : manager;

        if (scenario == 0) {
            (id, expected) = _unknown(seed);
            return (id, _anyCaller(caller), expected);
        }
        if (scenario == 4) {
            id = create(monthly());
            return (id, by, abi.encodeWithSelector(IMandateHub.NotStreaming.selector));
        }

        id = _openRunning(true, false, seed);
        // Every scenario but "not paused" starts from a paused stream when resuming.
        if (!pausing && scenario != 5) {
            vm.prank(by);
            hub.pauseMandate(id);
        }

        if (scenario == 1) {
            uint256 pick = (seed >> 8) % 2;
            return (
                id,
                pick == 0 ? merchant : _outsider(caller, id),
                abi.encodeWithSelector(IMandateHub.NotAuthorized.selector)
            );
        }
        if (scenario == 2) {
            vm.prank(_role(seed >> 8));
            hub.cancelMandate(id);
            return (id, by, abi.encodeWithSelector(IMandateHub.MandateIsCancelled.selector));
        }
        if (scenario == 3) {
            uint64 expiresAt = hub.getMandate(id).expiresAt;
            vm.warp(uint256(expiresAt) + bound(seed >> 8, 1, 3650 days));
            return (id, by, abi.encodeWithSelector(IMandateHub.MandateExpired.selector, expiresAt, block.timestamp));
        }
        if (pausing) {
            vm.prank(by);
            hub.pauseMandate(id);
            vm.warp(block.timestamp + bound(seed >> 8, 0, 5 days));
            return (id, by, abi.encodeWithSelector(IMandateHub.MandateIsPaused.selector));
        }
        return (id, by, abi.encodeWithSelector(IMandateHub.MandateNotPaused.selector));
    }

    /*//////////////////////////////////////////////////////////////
                            RANDOM WALK PIECES
    //////////////////////////////////////////////////////////////*/

    /// @dev A periodic mandate and a stream in `usd`, a stream with no manager in the refusable
    ///      token, and a stream drawn from the vault.
    function _walkWorld() internal returns (uint256[4] memory ids) {
        ids[0] = create(monthly());
        ids[1] = create(perSecond());
        IMandateHub.Terms memory t = perSecond();
        t.asset = address(refusing);
        t.manager = address(0);
        ids[2] = create(t);
        ids[3] = create(_fromVault(perSecond()));
    }

    function _walkStep(uint256[4] memory ids, uint256 seed) internal {
        uint256 op = seed % 13;
        uint256 id = ids[(seed >> 8) % 4];
        address by = [payer, merchant, manager, stranger][(seed >> 16) % 4];
        uint256 arg = seed >> 24;

        if (op == 0) {
            vm.warp(block.timestamp + bound(arg, 0, 10 days));
        } else if (op == 5) {
            address[3] memory next = [address(0), manager, stranger];
            _try(by, abi.encodeCall(IMandateHub.setManager, (id, next[arg % 3])));
        } else if (op == 6) {
            refusing.setMode(RefusingToken.Mode(arg % 3));
        } else if (op == 7) {
            deal(arg % 2 == 0 ? address(usd) : address(refusing), payer, bound(arg >> 8, 0, 1_000 * DOLLAR));
        } else if (op == 8) {
            vm.prank(payer);
            IERC20(arg % 2 == 0 ? address(usd) : address(refusing))
                .approve(address(hub), bound(arg >> 8, 0, 1_000 * DOLLAR));
        } else if (op == 9) {
            vault.setPaysShort(arg % 2 == 1);
        } else if (op == 10) {
            vault.setLiquidity(arg % 2 == 0 ? type(uint256).max : bound(arg >> 8, 0, 100 * DOLLAR));
        } else if (op == 11) {
            vm.prank(payer);
            vault.approve(address(hub), bound(arg, 0, 1_000 * DOLLAR));
        } else if (op == 12) {
            vault.setZeroMax(arg % 2 == 1);
        } else {
            _try(by, _lifecycleCall(op, id));
        }
    }

    function _lifecycleCall(uint256 op, uint256 id) internal pure returns (bytes memory) {
        if (op == 1) return abi.encodeCall(IMandateHub.charge, (id));
        if (op == 2) return abi.encodeCall(IMandateHub.pauseMandate, (id));
        if (op == 3) return abi.encodeCall(IMandateHub.resumeMandate, (id));
        return abi.encodeCall(IMandateHub.cancelMandate, (id));
    }

    function _finalCall(uint256[4] memory ids, uint256 seed) internal view returns (address caller, bytes memory data) {
        uint256 fn = seed % 5;
        uint256 pick = (seed >> 8) % 6;
        uint256 id = pick == 0 ? 0 : pick == 5 ? hub.nextMandateId() : ids[pick - 1];
        caller = [payer, merchant, manager, stranger, relayer][(seed >> 16) % 5];

        if (fn == 0) data = abi.encodeCall(IMandateHub.charge, (id));
        else if (fn == 1) data = abi.encodeCall(IMandateHub.cancelMandate, (id));
        else if (fn == 2) data = abi.encodeCall(IMandateHub.pauseMandate, (id));
        else if (fn == 3) data = abi.encodeCall(IMandateHub.resumeMandate, (id));
        else data = abi.encodeCall(IMandateHub.setManager, (id, [address(0), manager, stranger][(seed >> 24) % 3]));
    }

    function _try(address by, bytes memory data) internal {
        vm.prank(by);
        (bool ok,) = address(hub).call(data);
        ok; // Outcome irrelevant: the walk only needs to reach varied states.
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Snapshot, call as `caller`, then require the exact revert and an identical snapshot.
    function _assertRevertsAndChangesNothing(address caller, bytes memory data, bytes memory expected) internal {
        bytes memory before = _snapshot(caller);

        vm.prank(caller);
        (bool ok, bytes memory returned) = address(hub).call(data);

        assertFalse(ok, "the call must revert");
        assertEq(returned, expected, "revert data");
        assertEq(_snapshot(caller), before, "a reverting call changed state");
    }

    /// @dev `nextMandateId` through its getter and its storage word; every record from id 0 to one
    ///      past the last through the getter and as its six raw words; and the supply, balances
    ///      and hub allowances of every asset and of the vault's shares for every party, the hub,
    ///      the vault and `caller` included.
    function _snapshot(address caller) internal view returns (bytes memory s) {
        uint256 next = hub.nextMandateId();
        s = abi.encode(next, vm.load(address(hub), bytes32(NEXT_ID_SLOT)));
        for (uint256 id = 0; id <= next; ++id) {
            s = bytes.concat(s, abi.encode(hub.getMandate(id)));
            for (uint256 w = 0; w < RECORD_WORDS; ++w) {
                s = bytes.concat(s, vm.load(address(hub), _slot(id, w)));
            }
        }

        address[] memory assets = hub.acceptedAssets();
        for (uint256 i = 0; i < assets.length; ++i) {
            s = bytes.concat(s, _holdings(IERC20(assets[i]), caller));
        }
        s = bytes.concat(s, _holdings(vault, caller));
    }

    function _holdings(IERC20 token, address caller) internal view returns (bytes memory s) {
        address[8] memory who = [payer, merchant, manager, stranger, relayer, address(hub), address(vault), caller];
        s = abi.encode(token.totalSupply());
        for (uint256 j = 0; j < who.length; ++j) {
            s = bytes.concat(s, abi.encode(token.balanceOf(who[j]), token.allowance(who[j], address(hub))));
        }
    }

    function _fromVault(IMandateHub.Terms memory t) internal view returns (IMandateHub.Terms memory) {
        t.vault = address(vault);
        return t;
    }

    function _slot(uint256 id, uint256 word) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(id, MANDATES_SLOT))) + word);
    }

    /// @dev Id zero, or any id at or past `nextMandateId`.
    function _unknown(uint256 seed) internal view returns (uint256 id, bytes memory) {
        id = seed % 2 == 0 ? 0 : bound(seed, hub.nextMandateId(), type(uint256).max);
        return (id, abi.encodeWithSelector(IMandateHub.UnknownMandate.selector));
    }

    /// @dev A fresh mandate of either mode, optionally without a manager, that has been running a
    ///      while, so a stream has something accrued that a wrongful settlement would move.
    function _openRunning(bool streaming, bool noManager, uint256 seed) internal returns (uint256 id) {
        IMandateHub.Terms memory t = streaming ? perSecond() : monthly();
        if (noManager) t.manager = address(0);
        id = create(t);
        vm.warp(block.timestamp + bound(seed >> 32, 0, 20 days));
    }

    /// @dev One of the three parties allowed to cancel.
    function _role(uint256 seed) internal view returns (address) {
        return [payer, merchant, manager][seed % 3];
    }

    /// @dev `candidate`, moved off the payer, the merchant, the manager and the zero address.
    function _outsider(address candidate, uint256 id) internal view returns (address) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        while (
            candidate == address(0) || candidate == m.payer || candidate == m.merchant || candidate == m.manager
                || !_pranksCleanly(candidate)
        ) {
            candidate = address(uint160(uint256(keccak256(abi.encode("outsider", candidate)))));
        }
        return candidate;
    }

    /// @dev Any caller at all for a permissionless call, except cheatcode and console addresses.
    function _anyCaller(address candidate) internal pure returns (address) {
        return _pranksCleanly(candidate) ? candidate : address(0xCA11E4);
    }

    function _pranksCleanly(address candidate) internal pure returns (bool) {
        return candidate != address(vm) && candidate != CONSOLE && candidate != CREATE2_FACTORY;
    }
}
