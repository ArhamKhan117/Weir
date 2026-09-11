// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MandateHub} from "../../../src/MandateHub.sol";
import {
    IMandateHub,
    ACTION_CANCEL,
    ACTION_PAUSE,
    ACTION_RESUME,
    REASON_INSUFFICIENT_BALANCE,
    REASON_INSUFFICIENT_ALLOWANCE,
    REASON_TRANSFER_REFUSED
} from "../../../src/interfaces/IMandateHub.sol";
import {TestStablecoin} from "../../../src/testnet/TestStablecoin.sol";
import {RefusingToken} from "../../mocks/RefusingToken.sol";
import {MockVault} from "../../mocks/MockVault.sol";

/// @title SkewedVault
/// @notice A `MockVault` that can also pay the receiver one base unit over, out of what its other
///         depositors hold, whenever it has that unit: the other way a vault can fail to pay
///         exactly. The handler never has it pay short and over at once.
contract SkewedVault is MockVault {
    bool public paysOver;

    constructor(IERC20 asset_) MockVault(asset_) {}

    function setPaysOver(bool paysOver_) external {
        paysOver = paysOver_;
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256 shares) {
        shares = super.withdraw(assets, receiver, owner);
        IERC20 token = IERC20(asset());
        if (paysOver && token.balanceOf(address(this)) != 0) SafeERC20.safeTransfer(token, receiver, 1);
    }
}

/// @title MandateHubHandler
/// @notice The only surface the invariant fuzzer drives: a small world of three payers, two
///         merchants and two managers with known keys, a stranger and a relayer, at most six
///         mandates of both modes over three assets (two plain dollars and one that can be switched
///         to refuse transfers), one vault over each asset that the payers save in (a `MockVault`
///         that can also pay over), and a clock that only moves forward. A mandate draws from the
///         payer's wallet or from the vault over its asset; one creation attempt in eight names
///         something that is not a vault over its asset and must be refused. Between hub calls the
///         payers deposit and withdraw, the vaults earn (and now and then lose), run short of
///         liquidity, start paying short or over, or switch to answering zero from every `max*`
///         view as Morpho Vault V2 does, and share allowances change. Some charges are made with a
///         vault mandate placed exactly on, or one unit off, a line between funded and not, and
///         the settlement pull is called from outside, where it must always refuse.
/// @dev Holds no assertions; `MandateHubInvariants` asserts on what it records.
///
///      Every hub call is made against a model of what must happen: the set of errors whose
///      condition holds right now, empty when the call must succeed. A revert outside that set,
///      or a success while it is not empty, is counted as unexpected. Around every hub call the
///      handler snapshots all records and balances (asset and vault share balances of every
///      party, the vaults included, and every share supply) and records the logs, then audits the
///      change: which record moved, which tokens moved from whom to whom, what each debit was
///      measured against. Anything that breaks a rule is counted in a breach counter, and
///      per-mandate ghost state (terms at creation, receipts, debits, pause history) and a ledger
///      of every vault position are kept for the invariants.
///
///      `vm.recordLogs` also records logs emitted inside frames that later reverted. The transfer
///      audit therefore reads no value movement from a call that reverted, nor from a charge or
///      settlement whose pull was rolled back and reported as failed, and when a vault mandate
///      was paid from the balance it reads only the payer's transfer, since the vault's attempt
///      before it was rolled back; in every case the balance audit proves exactly what moved.
///
///      Nothing in the handler itself may revert, since a reverted handler call would also roll
///      back the counter that recorded the problem. All arithmetic here is guarded accordingly.
contract MandateHubHandler is CommonBase, StdCheats, StdUtils {
    /*//////////////////////////////////////////////////////////////
                                  WORLD
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_MANDATES = 6;

    /// @dev Signed calls draw nonces from this small space, so reuse, and its refusal, is common.
    uint256 public constant NONCE_SPACE = 8;

    /// @dev What each payer holds in each vault at the start.
    uint256 public constant INITIAL_SAVINGS = 400e6;

    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes4 internal constant ERROR_STRING = 0x08c379a0;

    /// @dev The EIP-712 types a client signs, written out here rather than read from the hub, so
    ///      the handler signs the way an independent wallet would.
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TERMS_TYPEHASH = keccak256(
        "Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );
    bytes32 internal constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address payer,Terms terms,uint256 nonce,uint256 deadline)Terms(address merchant,address asset,address vault,address manager,uint96 amount,uint32 period,uint64 startAt,uint96 maxPerCharge,uint96 maxTotal,uint64 expiresAt,bytes32 ref)"
    );
    bytes32 internal constant ACTION_TYPEHASH =
        keccak256("MandateAction(uint256 mandateId,uint8 action,uint256 nonce,uint256 deadline)");
    bytes32 internal constant SET_MANAGER_TYPEHASH =
        keccak256("SetManager(uint256 mandateId,address manager,uint256 nonce,uint256 deadline)");

    /// @dev The domain the hub was deployed under, as its deployer knows it.
    bytes32 internal immutable _domainSeparator;

    MandateHub public immutable hub;
    TestStablecoin public immutable usd;
    TestStablecoin public immutable ausd;
    RefusingToken public immutable refusing;

    address[3] public payers;
    address[2] public merchants;
    address[2] public managers;
    address public stranger;
    address public relayer;

    /// @dev `vaults[i]` is over `_assets[i]`.
    SkewedVault[3] public vaults;

    uint256[3] internal _payerKeys = [uint256(0xA11CE), 0xB0B, 0xCA401];
    uint256[2] internal _merchantKeys = [uint256(0x3E4C1), 0x3E4C2];
    uint256[2] internal _managerKeys = [uint256(0x5E55), 0x5E56];
    uint256 internal constant STRANGER_KEY = 0xBAD;

    /// @dev Every address whose balances the audit watches: the parties, the hub, then the vaults.
    address[] internal _accounts;
    address[] internal _assets;
    /// @dev Every token the audit watches: the assets, then the vaults' shares.
    address[] internal _tokens;
    address[] internal _signers;

    /*//////////////////////////////////////////////////////////////
                               GHOST STATE
    //////////////////////////////////////////////////////////////*/

    /// @dev What the handler observed about one mandate over its whole life.
    struct Ghost {
        // The record exactly as stored right after creation.
        IMandateHub.Mandate created;
        // The manager the handler expects: the created one, replaced only by a payer's change.
        address manager;
        // Sum of every token transfer seen paying this mandate's merchant in its asset: from its
        // payer, or for a mandate drawn from a vault, from that vault or, when it could not pay,
        // from the payer's balance.
        uint256 receipts;
        // For a mandate drawn from a vault: what its payer's balance paid when the vault could not.
        uint256 fromBalance;
        // Successful debits, and the largest, smallest and latest of them.
        uint256 debits;
        uint256 maxDebit;
        uint256 minDebit;
        uint64 lastDebitAt;
        // Set by a successful cancel, with the total at that moment.
        bool cancelled;
        uint96 totalAtCancel;
        // The pause moment while paused, else zero.
        uint64 pausedSince;
        // Seconds spent paused at or after the stream's start, over completed pauses.
        uint256 pausedOverlap;
        // Periodic only: the lattice period, counted from the anchor, of the latest debit.
        uint256 lastPeriodIndex;
    }

    mapping(uint256 id => Ghost) internal _ghost;
    uint256[] internal _createdIds;

    /// @dev The nonces the handler has seen consumed by a successful signed call.
    mapping(address signer => mapping(uint256 nonce => bool)) public nonceModel;

    /// @dev The vault ledger, kept from the handler's own actions (measured) and from the debits
    ///      the hub booked (priced by the vault before each call), never read back from the hub:
    ///      the shares each payer must hold in each vault, the assets each vault must hold, and
    ///      the assets each payer's position in each vault has paid to merchants.
    mapping(address payer => mapping(uint256 vault => uint256)) public expectedShares;
    uint256[3] public expectedVaultAssets;
    mapping(address payer => mapping(uint256 vault => uint256)) public paidFromVault;

    /*//////////////////////////////////////////////////////////////
                            BREACH COUNTERS
    //////////////////////////////////////////////////////////////*/

    // A call reverted although no revert condition held, or with an error none of them explains.
    uint256 public unexpectedReverts;
    // A call succeeded although a revert condition held.
    uint256 public unexpectedSuccesses;
    // A token moved other than as the acted-on mandate's pull: its asset from its payer to its
    // merchant, or for a vault mandate its asset from its vault to its merchant and its payer's
    // shares burned.
    uint256 public strayTransfers;
    // Some watched balance or share supply moved other than by exactly the booked debit.
    uint256 public conservationBreaches;
    // A debit above `maxPerCharge`, a periodic debit other than `amount` or before its boundary,
    // or a stream debit above rate times seconds since the checkpoint.
    uint256 public capBreaches;
    uint256 public debitsAfterExpiry;
    uint256 public debitsWhilePaused;
    // A `ChargeFailed` that came with a transfer, a booked amount, a moved schedule, or no delinquency.
    uint256 public failedChargeBreaches;
    // A cancelled record that changed in any way.
    uint256 public cancelledMutations;
    // A record changed by a call that acted on a different mandate.
    uint256 public foreignMutations;
    // A term (anything but manager, nextChargeAt, status, totalCharged, pausedAt) changed.
    uint256 public termMutations;
    // A created record that differs from its terms, or an id out of sequence.
    uint256 public creationMismatches;
    uint256 public totalDecreases;
    // A `Charged` event that disagrees with the record, or a debit without exactly one.
    uint256 public chargedEventMismatches;
    // The schedule or checkpoint moved other than as specified, or two debits shared a period.
    uint256 public scheduleBreaches;
    // A successful call debited other than exactly what the specification says it must, or
    // reported a failed charge it should not have (or failed to report one it should have, or for
    // another amount, or with another reason).
    uint256 public fallbackEventMismatches;
    uint256 public settlementBreaches;
    // A merchant of a vault mandate received, from the vault or at all, other than exactly the
    // amount the call booked.
    uint256 public vaultPaymentBreaches;
    // A payer's vault shares moved in a hub call other than by exactly the shares the vault prices
    // the booked debit at, or the ledger would have gone negative.
    uint256 public positionBreaches;

    /// @dev The revert data (or a label) of the most recent unexpected outcome, for the trace.
    bytes public lastUnexpected;

    /*//////////////////////////////////////////////////////////////
                                COVERAGE
    //////////////////////////////////////////////////////////////*/

    uint256 public legitReverts;
    uint256 public successfulDebits;
    uint256 public chargeFailures;
    uint256 public directCreates;
    uint256 public signedCreates;
    uint256 public signedActions;
    uint256 public signedManagerChanges;
    uint256 public cancels;
    uint256 public pauses;
    uint256 public resumes;
    uint256 public managerChanges;
    uint256 public vaultMandates;
    uint256 public vaultDebits;
    uint256 public vaultChargeFailures;
    uint256 public refusedSettlements;
    uint256 public balanceFallbacks;
    uint256 public invalidVaultRefusals;
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public yields;
    uint256 public losses;
    uint256 public edgeProbes;

    /*//////////////////////////////////////////////////////////////
                            MODEL SCAFFOLDING
    //////////////////////////////////////////////////////////////*/

    /// @dev The errors a call may revert with right now. Empty means it must succeed.
    struct Expect {
        bytes4[10] errors;
        uint256 count;
    }

    /// @dev One signed call as submitted, with its expected outcome.
    struct Signed {
        address signer;
        uint256 key;
        uint256 nonce;
        uint256 deadline;
        bool wrongKey;
        bytes signature;
        Expect expect;
    }

    /// @dev Everything captured before a hub call, and what a success must do to the target:
    ///      book exactly `debit` (burning exactly `shareCost` shares when it draws from a vault),
    ///      or report a `ChargeFailed` for exactly `failure` with exactly `reason`.
    struct Pre {
        IMandateHub.Mandate[] records;
        uint256[] balances;
        uint256 debit;
        uint256 failure;
        uint8 reason;
        uint256 shareCost;
        // The debit is a vault mandate's, paid from the payer's balance because the vault could not.
        bool fromBalance;
        bool succeeded;
    }

    /// @param domainName The EIP-712 name the hub was deployed with.
    /// @param domainVersion The EIP-712 version the hub was deployed with.
    constructor(
        MandateHub hub_,
        TestStablecoin usd_,
        TestStablecoin ausd_,
        RefusingToken refusing_,
        string memory domainName,
        string memory domainVersion
    ) {
        hub = hub_;
        _domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes(domainName)), keccak256(bytes(domainVersion)), block.chainid, hub_
            )
        );
        usd = usd_;
        ausd = ausd_;
        refusing = refusing_;
        _assets.push(address(usd_));
        _assets.push(address(ausd_));
        _assets.push(address(refusing_));

        for (uint256 i = 0; i < 3; ++i) {
            payers[i] = _keyed(_payerKeys[i], string.concat("payer", vm.toString(i)));
            vaults[i] = new SkewedVault(IERC20(_assets[i]));
            vm.label(address(vaults[i]), string.concat("vault", vm.toString(i)));
        }
        for (uint256 i = 0; i < 2; ++i) {
            merchants[i] = _keyed(_merchantKeys[i], string.concat("merchant", vm.toString(i)));
            managers[i] = _keyed(_managerKeys[i], string.concat("manager", vm.toString(i)));
        }
        stranger = _keyed(STRANGER_KEY, "stranger");
        relayer = makeAddr("relayer");

        for (uint256 i = 0; i < 3; ++i) {
            _accounts.push(payers[i]);
        }
        for (uint256 i = 0; i < 2; ++i) {
            _accounts.push(merchants[i]);
        }
        for (uint256 i = 0; i < 2; ++i) {
            _accounts.push(managers[i]);
        }
        _accounts.push(stranger);
        _accounts.push(relayer);
        _accounts.push(address(hub_));
        for (uint256 i = 0; i < 3; ++i) {
            _accounts.push(address(vaults[i]));
        }
        for (uint256 i = 0; i < 3; ++i) {
            _tokens.push(_assets[i]);
        }
        for (uint256 i = 0; i < 3; ++i) {
            _tokens.push(address(vaults[i]));
        }

        // Everyone but the relayer, the hub and the vaults holds a key.
        for (uint256 i = 0; i < 8; ++i) {
            _signers.push(_accounts[i]);
        }

        // A thousand dollars in the wallet and savings in every vault, each approved to the hub.
        for (uint256 i = 0; i < 3; ++i) {
            for (uint256 j = 0; j < 3; ++j) {
                deal(_assets[j], payers[i], 1_000e6 + INITIAL_SAVINGS);
                vm.startPrank(payers[i]);
                IERC20(_assets[j]).approve(address(hub_), 2_000e6);
                IERC20(_assets[j]).approve(address(vaults[j]), INITIAL_SAVINGS);
                vaults[j].deposit(INITIAL_SAVINGS, payers[i]);
                vaults[j].approve(address(hub_), 2_000e6);
                vm.stopPrank();
                expectedShares[payers[i]][j] = vaults[j].balanceOf(payers[i]);
            }
        }
        for (uint256 j = 0; j < 3; ++j) {
            expectedVaultAssets[j] = IERC20(_assets[j]).balanceOf(address(vaults[j]));
        }
    }

    /*//////////////////////////////////////////////////////////////
                                CREATION
    //////////////////////////////////////////////////////////////*/

    /// @param who Picks the payer, merchant, asset, manager and vault.
    function createPeriodic(
        uint256 who,
        uint256 amountSeed,
        uint256 periodSeed,
        uint256 startSeed,
        uint256 capSeed,
        uint256 expirySeed
    ) external {
        if (_createdIds.length >= MAX_MANDATES) return;
        _createDirect(payers[who % 3], _periodicTerms(who, amountSeed, periodSeed, startSeed, capSeed, expirySeed));
    }

    /// @param who Picks the payer, merchant, asset, manager and vault.
    function createStream(
        uint256 who,
        uint256 rateSeed,
        uint256 capSeed,
        uint256 totalSeed,
        uint256 startSeed,
        uint256 expirySeed
    ) external {
        if (_createdIds.length >= MAX_MANDATES) return;
        _createDirect(payers[who % 3], _streamTerms(who, rateSeed, capSeed, totalSeed, startSeed, expirySeed));
    }

    /// @notice A creation signed by a payer and submitted by the relayer. One run in eight signs
    ///         with the wrong key, one in eight carries an expired deadline and one in eight a
    ///         deadline of exactly now; nonces repeat.
    function signedCreate(uint256 who, uint256 shapeSeed, uint256 nonceSeed, uint256 deadlineSeed, uint256 keySeed)
        external
    {
        if (_createdIds.length >= MAX_MANDATES) return;
        address payer = payers[who % 3];
        IMandateHub.Terms memory t = shapeSeed % 2 == 0
            ? _periodicTerms(
                who, _h(shapeSeed, 1), _h(shapeSeed, 2), _h(shapeSeed, 3), _h(shapeSeed, 4), _h(shapeSeed, 5)
            )
            : _streamTerms(
                who, _h(shapeSeed, 1), _h(shapeSeed, 2), _h(shapeSeed, 3), _h(shapeSeed, 4), _h(shapeSeed, 5)
            );

        Signed memory s = _signed(payer, keySeed, nonceSeed, deadlineSeed);
        s.signature = _sign(s.key, _digest(_createHash(payer, t, s.nonce, s.deadline)));
        _signatureErrors(s);
        _merge(s.expect, _createErrors(t));
        _submitCreate(s, t);
    }

    /*//////////////////////////////////////////////////////////////
                                CHARGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Charge any mandate, known or not, from any caller.
    function charge(uint256 idSeed, uint256 callerSeed) external {
        _charge(_pickId(idSeed), _anyone(callerSeed));
    }

    /// @notice Charge a mandate the hub says is chargeable, so charges are frequent. When none
    ///         is, first move the clock forward to the soonest moment a live one becomes due.
    function chargeDue(uint256 idSeed) external {
        uint256 n = _createdIds.length;
        if (n == 0) return;
        uint256 first = idSeed % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = (first + i) % n + 1;
            if (hub.isChargeable(id)) {
                _charge(id, relayer);
                return;
            }
        }

        (uint256 soonest, uint256 at) = _soonestDue();
        if (soonest == 0) return;
        vm.warp(at);
        _charge(soonest, relayer);
    }

    /*//////////////////////////////////////////////////////////////
                                LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function cancel(uint256 idSeed, uint256 actorSeed) external {
        uint256 id = _pickId(idSeed);
        address by = _actor(id, actorSeed);
        Expect memory x = _cancelErrors(id, by);

        Pre memory p = _pre();
        _expectPull(p, id, true);
        vm.prank(by);
        try hub.cancelMandate(id) {
            p.succeeded = true;
            _succeeded("cancelMandate", x);
            _onCancelled(id);
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    function pause(uint256 idSeed, uint256 actorSeed) external {
        uint256 id = _pickStream(idSeed, false);
        address by = _actor(id, actorSeed);
        Expect memory x = _streamControlErrors(id, by, true);

        Pre memory p = _pre();
        _expectPull(p, id, true);
        vm.prank(by);
        try hub.pauseMandate(id) {
            p.succeeded = true;
            _succeeded("pauseMandate", x);
            _onPaused(id);
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    function resume(uint256 idSeed, uint256 actorSeed) external {
        uint256 id = _pickStream(idSeed, true);
        address by = _actor(id, actorSeed);
        Expect memory x = _streamControlErrors(id, by, false);

        Pre memory p = _pre();
        vm.prank(by);
        try hub.resumeMandate(id) {
            p.succeeded = true;
            _succeeded("resumeMandate", x);
            _onResumed(id);
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    function setManager(uint256 idSeed, uint256 actorSeed, uint256 managerSeed) external {
        uint256 id = _pickId(idSeed);
        address by = _actor(id, actorSeed);
        address next = _managerChoice(managerSeed);
        Expect memory x = _setManagerErrors(id, by);

        Pre memory p = _pre();
        vm.prank(by);
        try hub.setManager(id, next) {
            p.succeeded = true;
            _succeeded("setManager", x);
            _onManagerSet(id, next);
            ++managerChanges;
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    /// @notice A cancel, pause or resume (or, one run in four, an invalid action code) signed by
    ///         any keyed party and submitted by the relayer.
    function signedAction(
        uint256 idSeed,
        uint256 actionSeed,
        uint256 signerSeed,
        uint256 nonceSeed,
        uint256 deadlineSeed
    ) external {
        uint8 action = _actionCode(actionSeed);
        uint256 id = action == ACTION_PAUSE || action == ACTION_RESUME
            ? _pickStream(idSeed, action == ACTION_RESUME)
            : _pickId(idSeed);
        Signed memory s = _signed(_actor(id, signerSeed), signerSeed, nonceSeed, deadlineSeed);
        s.signature = _sign(s.key, _digest(keccak256(abi.encode(ACTION_TYPEHASH, id, action, s.nonce, s.deadline))));

        _signatureErrors(s);
        if (action == ACTION_CANCEL) _merge(s.expect, _cancelErrors(id, s.signer));
        else if (action == ACTION_PAUSE) _merge(s.expect, _streamControlErrors(id, s.signer, true));
        else if (action == ACTION_RESUME) _merge(s.expect, _streamControlErrors(id, s.signer, false));
        else _allow(s.expect, IMandateHub.InvalidAction.selector);

        _submitAction(id, action, s);
    }

    /// @notice A manager change signed by the payer (or, one run in eight, by a manager key) and
    ///         submitted by the relayer.
    function signedSetManager(
        uint256 idSeed,
        uint256 managerSeed,
        uint256 keySeed,
        uint256 nonceSeed,
        uint256 deadlineSeed
    ) external {
        uint256 id = _pickId(idSeed);
        address next = _managerChoice(managerSeed);
        IMandateHub.Mandate memory m = hub.getMandate(id);

        Signed memory s = _signed(m.payer == address(0) ? stranger : m.payer, keySeed, nonceSeed, deadlineSeed);
        if (s.wrongKey) s.key = _managerKeys[_h(keySeed, 1) % 2];
        s.signature = _sign(s.key, _digest(keccak256(abi.encode(SET_MANAGER_TYPEHASH, id, next, s.nonce, s.deadline))));

        if (m.payer == address(0)) {
            _allow(s.expect, IMandateHub.UnknownMandate.selector);
        } else {
            _signatureErrors(s);
            if (m.status == IMandateHub.Status.Cancelled) _allow(s.expect, IMandateHub.MandateIsCancelled.selector);
        }

        _submitSetManager(id, next, s);
    }

    /*//////////////////////////////////////////////////////////////
                           CLOCK AND FUNDING
    //////////////////////////////////////////////////////////////*/

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 3 days));
    }

    /// @notice Jump to a boundary of one mandate: just before, at or just after its next charge,
    ///         or (one time in four) at or just after its expiry. Only ever forward.
    function warpToEdge(uint256 idSeed, uint256 edgeSeed) external {
        uint256 n = _createdIds.length;
        if (n == 0) return;
        IMandateHub.Mandate memory m = hub.getMandate(idSeed % n + 1);
        uint256 edge = edgeSeed % 8;
        uint256 target;
        if (edge == 0) target = uint256(m.nextChargeAt) - 1;
        else if (edge < 4) target = m.nextChargeAt;
        else if (edge < 6) target = uint256(m.nextChargeAt) + 1;
        else if (edge == 6) target = m.expiresAt;
        else target = uint256(m.expiresAt) + 1;
        if (target > block.timestamp) vm.warp(target);
    }

    /// @notice Zero one time in four, otherwise anything up to 1,000 dollars, so a payer is
    ///         often short of a charge.
    function setBalance(uint256 payerSeed, uint256 assetSeed, uint256 amount) external {
        uint256 balance = _h(amount, 0) % 4 == 3 ? 0 : bound(amount, 0, 1_000e6);
        deal(_assets[assetSeed % 3], payers[payerSeed % 3], balance);
    }

    /// @notice Zero or unlimited one time in four each, otherwise anything up to 200 dollars.
    function setAllowance(uint256 payerSeed, uint256 assetSeed, uint256 amount) external {
        uint256 k = _h(amount, 0) % 4;
        uint256 allowance = k == 3 ? 0 : k == 2 ? type(uint256).max : bound(amount, 0, 200e6);
        vm.prank(payers[payerSeed % 3]);
        IERC20(_assets[assetSeed % 3]).approve(address(hub), allowance);
    }

    /// @notice Switch the refusable token between normal, returning false and reverting, with
    ///         normal as likely as the other two together.
    function setRefusal(uint256 modeSeed) external {
        uint256 k = modeSeed % 4;
        refusing.setMode(
            k < 2 ? RefusingToken.Mode.Normal : k == 2 ? RefusingToken.Mode.ReturnFalse : RefusingToken.Mode.Revert
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 VAULTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A payer moves any part of its wallet into a vault. The refusable token is set to
    ///         normal for the deposit itself, so a refusal aimed at the hub never blocks saving.
    function deposit(uint256 payerSeed, uint256 vaultSeed, uint256 amount) external {
        address payer = payers[payerSeed % 3];
        uint256 i = vaultSeed % 3;
        SkewedVault vault = vaults[i];
        IERC20 asset = IERC20(_assets[i]);
        amount = bound(amount, 0, asset.balanceOf(payer));

        RefusingToken.Mode mode = refusing.mode();
        refusing.setMode(RefusingToken.Mode.Normal);
        (uint256 shares, uint256 held) = (vault.balanceOf(payer), asset.balanceOf(address(vault)));
        vm.startPrank(payer);
        asset.approve(address(vault), amount);
        vault.deposit(amount, payer);
        vm.stopPrank();
        refusing.setMode(mode);

        expectedShares[payer][i] += vault.balanceOf(payer) - shares;
        expectedVaultAssets[i] += asset.balanceOf(address(vault)) - held;
        ++deposits;
    }

    /// @notice A payer takes any part of what the vault will let it withdraw back to its wallet:
    ///         its position's worth, up to the vault's liquidity. Read from the position rather
    ///         than `maxWithdraw`, which a vault in the zero-max mode answers with zero.
    function withdraw(uint256 payerSeed, uint256 vaultSeed, uint256 amount) external {
        address payer = payers[payerSeed % 3];
        uint256 i = vaultSeed % 3;
        SkewedVault vault = vaults[i];
        IERC20 asset = IERC20(_assets[i]);
        uint256 worth = vault.previewRedeem(vault.balanceOf(payer));
        amount = bound(amount, 0, worth < vault.liquidity() ? worth : vault.liquidity());
        // A vault paying short would underflow on a zero withdrawal.
        if (amount == 0 && vault.paysShort()) return;

        (uint256 shares, uint256 held) = (vault.balanceOf(payer), asset.balanceOf(address(vault)));
        vm.prank(payer);
        vault.withdraw(amount, payer, payer);

        _debitLedger(payer, i, shares - vault.balanceOf(payer), held - asset.balanceOf(address(vault)));
        ++withdrawals;
    }

    /// @notice Yield of up to the vault's whole holding lands in it, so share prices drift well
    ///         away from one; one time in four it is instead a loss of up to a quarter of it.
    function accrueYield(uint256 vaultSeed, uint256 amount) external {
        uint256 i = vaultSeed % 3;
        address vault = address(vaults[i]);
        uint256 held = IERC20(_assets[i]).balanceOf(vault);

        if (_h(amount, 0) % 4 == 3) {
            uint256 loss = bound(amount, 0, held / 4);
            deal(_assets[i], vault, held - loss);
            _debitLedger(address(0), i, 0, loss);
            ++losses;
        } else {
            uint256 gain = bound(amount, 0, held + 1e6);
            deal(_assets[i], vault, held + gain);
            expectedVaultAssets[i] += gain;
            ++yields;
        }
    }

    /// @notice No cap half the time, no liquidity at all one time in four, otherwise a cap of up
    ///         to 100 dollars, around the size of a charge.
    function setLiquidity(uint256 vaultSeed, uint256 seed) external {
        uint256 k = seed % 4;
        vaults[vaultSeed % 3].setLiquidity(k < 2 ? type(uint256).max : k == 2 ? 0 : bound(seed >> 2, 0, 100e6));
    }

    /// @notice Pay short or pay exactly, evenly.
    function setPaysShort(uint256 vaultSeed, uint256 seed) external {
        SkewedVault vault = vaults[vaultSeed % 3];
        vault.setPaysOver(false);
        vault.setPaysShort(seed % 2 == 1);
    }

    /// @notice Pay over or pay exactly, evenly.
    function setPaysOver(uint256 vaultSeed, uint256 seed) external {
        SkewedVault vault = vaults[vaultSeed % 3];
        vault.setPaysShort(false);
        vault.setPaysOver(seed % 2 == 1);
    }

    /// @notice Answer zero from every `max*` view, as Morpho Vault V2 does, or report the vault's
    ///         limits, evenly. The hub must behave identically either way.
    function setZeroMax(uint256 vaultSeed, uint256 seed) external {
        vaults[vaultSeed % 3].setZeroMax(seed % 2 == 1);
    }

    /// @notice A payer's share allowance to the hub: zero or unlimited one time in four each,
    ///         otherwise anything up to 200 dollars' worth of shares at par.
    function setShareAllowance(uint256 payerSeed, uint256 vaultSeed, uint256 amount) external {
        uint256 k = _h(amount, 0) % 4;
        uint256 allowance = k == 3 ? 0 : k == 2 ? type(uint256).max : bound(amount, 0, 200e6);
        vm.prank(payers[payerSeed % 3]);
        vaults[vaultSeed % 3].approve(address(hub), allowance);
    }

    /// @notice Put a chargeable mandate drawn from a vault exactly on, or one unit off, a line
    ///         between funded and not, then charge it (or, for a stream one time in three, have
    ///         the payer pause it, so the settlement meets the line): the vault's liquidity at the
    ///         amount due or one below; the payer's share allowance at the vault's price for it,
    ///         one share below, or the amount itself counted as if it were shares; or the payer's
    ///         shares at that price or one below, moved to or from another payer, which leaves the
    ///         price where it was.
    function chargeAtVaultEdge(uint256 idSeed, uint256 edgeSeed) external {
        uint256 id = _pickChargeableFromVault(idSeed);
        if (id == 0) return;
        IMandateHub.Mandate memory m = hub.getMandate(id);
        SkewedVault vault = SkewedVault(m.vault);
        uint256 due = _dueAmount(m);
        uint256 cost = vault.previewWithdraw(due);

        uint256 edge = edgeSeed % 7;
        if (edge < 2) {
            vault.setLiquidity(edge == 0 ? due : due - 1);
        } else if (edge < 5) {
            vm.prank(m.payer);
            vault.approve(address(hub), edge == 2 ? cost : edge == 3 ? cost - 1 : due);
        } else if (!_holdExactly(m.payer, _vaultIndex(m.vault), edge == 5 ? cost : cost - 1)) {
            return;
        }
        ++edgeProbes;

        if (m.period == 0 && (edgeSeed / 7) % 3 == 2) {
            Expect memory x = _streamControlErrors(id, m.payer, true);
            Pre memory p = _pre();
            _expectPull(p, id, true);
            vm.prank(m.payer);
            try hub.pauseMandate(id) {
                p.succeeded = true;
                _succeeded("pauseMandate", x);
                _onPaused(id);
            } catch (bytes memory err) {
                _reverted(x, err);
            }
            _post(id, p);
        } else {
            _charge(id, relayer);
        }
    }

    /// @notice The settlement pull called from outside, by anyone but the hub, for any mandate
    ///         and amount: it must always refuse, and move nothing.
    function pullForSettlement(uint256 idSeed, uint256 callerSeed, uint256 amount) external {
        uint256 id = _pickId(idSeed);
        Expect memory x;
        _allow(x, IMandateHub.NotAuthorized.selector);

        Pre memory p = _pre();
        vm.prank(_anyone(callerSeed));
        try hub.pullForSettlement(id, bound(amount, 0, 100e6)) {
            p.succeeded = true;
            _succeeded("pullForSettlement", x);
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    /// @dev Leave `payer` holding exactly `shares` of vault `v` by moving the difference to or
    ///      from another payer, keeping the ledger in step. False, with nothing moved, when the
    ///      other payer cannot cover a shortfall.
    function _holdExactly(address payer, uint256 v, uint256 shares) internal returns (bool) {
        SkewedVault vault = vaults[v];
        address other = payers[0] == payer ? payers[1] : payers[0];
        uint256 held = vault.balanceOf(payer);
        (address from, address to, uint256 moved) =
            held >= shares ? (payer, other, held - shares) : (other, payer, shares - held);
        if (vault.balanceOf(from) < moved) return false;

        vm.prank(from);
        vault.transfer(to, moved);
        // Clamped like `_debitLedger`: a ledger already broken is counted, never a revert here.
        uint256 ledger = expectedShares[from][v];
        if (ledger < moved) ++positionBreaches;
        expectedShares[from][v] = ledger < moved ? 0 : ledger - moved;
        expectedShares[to][v] += moved;
        return true;
    }

    /*//////////////////////////////////////////////////////////////
                             VIEWS FOR ASSERTS
    //////////////////////////////////////////////////////////////*/

    function mandateCount() external view returns (uint256) {
        return _createdIds.length;
    }

    function createdId(uint256 index) external view returns (uint256) {
        return _createdIds[index];
    }

    function ghost(uint256 id) external view returns (Ghost memory) {
        return _ghost[id];
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    /*//////////////////////////////////////////////////////////////
                          SUBMISSION AND AUDIT
    //////////////////////////////////////////////////////////////*/

    function _createDirect(address payer, IMandateHub.Terms memory t) internal {
        uint64 start = _expectedStart(t);
        uint256 expectedId = hub.nextMandateId();
        Expect memory x = _createErrors(t);

        Pre memory p = _pre();
        vm.prank(payer);
        try hub.createMandate(t) returns (uint256 id) {
            p.succeeded = true;
            _succeeded("createMandate", x);
            ++directCreates;
            _onCreated(id, expectedId, payer, t, start);
            _postCreated(id, p, payer, t, start);
        } catch (bytes memory err) {
            _revertedCreating(x, err, t);
            _post(0, p);
        }
    }

    function _submitCreate(Signed memory s, IMandateHub.Terms memory t) internal {
        uint64 start = _expectedStart(t);
        uint256 expectedId = hub.nextMandateId();

        Pre memory p = _pre();
        vm.prank(relayer);
        try hub.createMandateWithSig(s.signer, t, s.nonce, s.deadline, s.signature) returns (uint256 id) {
            p.succeeded = true;
            _succeeded("createMandateWithSig", s.expect);
            nonceModel[s.signer][s.nonce] = true;
            ++signedCreates;
            _onCreated(id, expectedId, s.signer, t, start);
            _postCreated(id, p, s.signer, t, start);
        } catch (bytes memory err) {
            _revertedCreating(s.expect, err, t);
            _post(0, p);
        }
    }

    function _submitAction(uint256 id, uint8 action, Signed memory s) internal {
        Pre memory p = _pre();
        if (action == ACTION_CANCEL || action == ACTION_PAUSE) _expectPull(p, id, true);
        vm.prank(relayer);
        try hub.actWithSig(id, action, s.signer, s.nonce, s.deadline, s.signature) {
            p.succeeded = true;
            _succeeded("actWithSig", s.expect);
            nonceModel[s.signer][s.nonce] = true;
            ++signedActions;
            if (action == ACTION_CANCEL) _onCancelled(id);
            else if (action == ACTION_PAUSE) _onPaused(id);
            else if (action == ACTION_RESUME) _onResumed(id);
        } catch (bytes memory err) {
            _reverted(s.expect, err);
        }
        _post(id, p);
    }

    function _submitSetManager(uint256 id, address next, Signed memory s) internal {
        Pre memory p = _pre();
        vm.prank(relayer);
        try hub.setManagerWithSig(id, next, s.nonce, s.deadline, s.signature) {
            p.succeeded = true;
            _succeeded("setManagerWithSig", s.expect);
            nonceModel[s.signer][s.nonce] = true;
            ++signedManagerChanges;
            _onManagerSet(id, next);
        } catch (bytes memory err) {
            _reverted(s.expect, err);
        }
        _post(id, p);
    }

    function _charge(uint256 id, address caller) internal {
        Expect memory x = _chargeErrors(id);
        Pre memory p = _pre();
        _expectPull(p, id, false);
        vm.prank(caller);
        try hub.charge(id) {
            p.succeeded = true;
            _succeeded("charge", x);
        } catch (bytes memory err) {
            _reverted(x, err);
        }
        _post(id, p);
    }

    /// @dev Snapshot every record and watched balance, then start recording logs.
    function _pre() internal returns (Pre memory p) {
        uint256 n = _createdIds.length;
        p.records = new IMandateHub.Mandate[](n);
        for (uint256 i = 0; i < n; ++i) {
            p.records[i] = hub.getMandate(i + 1);
        }
        p.balances = _balances();
        vm.recordLogs();
    }

    /// @dev Audit everything the call changed. `target` is the mandate the call acted on.
    function _post(uint256 target, Pre memory p) internal {
        _audit(target, p, vm.getRecordedLogs());
    }

    /// @dev `_post` for a creation, which must also have emitted exactly one `MandateCreated`
    ///      carrying every agreed term, the vault included.
    function _postCreated(uint256 id, Pre memory p, address payer, IMandateHub.Terms memory t, uint64 start) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory data = bytes.concat(
            abi.encode(t.asset, t.vault, t.manager, t.amount, t.period, start),
            abi.encode(t.maxPerCharge, t.maxTotal, t.expiresAt, t.ref)
        );
        uint256 created;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(hub) || log.topics.length == 0) continue;
            if (log.topics[0] != IMandateHub.MandateCreated.selector) continue;
            ++created;
            if (
                log.topics.length != 4 || uint256(log.topics[1]) != id
                    || log.topics[2] != bytes32(uint256(uint160(payer)))
                    || log.topics[3] != bytes32(uint256(uint160(t.merchant))) || keccak256(log.data) != keccak256(data)
            ) ++creationMismatches;
        }
        if (created != 1) ++creationMismatches;
        _audit(id, p, logs);
    }

    function _audit(uint256 target, Pre memory p, Vm.Log[] memory logs) internal {
        uint256 targetDelta;
        for (uint256 i = 0; i < p.records.length; ++i) {
            uint256 id = i + 1;
            uint256 delta = _auditRecord(id, id == target, p.records[i], hub.getMandate(id), logs);
            if (id == target) targetDelta = delta;
        }

        // Logs of a reverted call, or of a settlement pull that was rolled back, describe nothing
        // that happened; the balance audit below proves nothing moved.
        uint8 reason = _failureReason(target, logs);
        bool voided = !p.succeeded || reason != 0;
        (uint256 paid, uint256 burned) = _auditTransfers(target, logs, voided, p.fromBalance);
        _auditFallbackEvent(target, targetDelta, p, logs);
        uint256[] memory afterward = _balances();
        _auditBalances(target, targetDelta, p, afterward);
        if (p.succeeded) _auditSettlement(target, targetDelta, p, logs);
        _auditVault(target, targetDelta, p, afterward, paid, burned, reason);
    }

    /// @dev A successful call booked exactly the debit the specification requires of it, and
    ///      reported a failed charge exactly when, and for exactly the amount and the reason, it
    ///      should have.
    function _auditSettlement(uint256 target, uint256 delta, Pre memory p, Vm.Log[] memory logs) internal {
        if (delta != p.debit) ++settlementBreaches;

        uint256 failures;
        uint8 reason;
        uint256 required;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isChargeFailed(logs[i], target)) {
                ++failures;
                (reason, required) = abi.decode(logs[i].data, (uint8, uint256));
            }
        }
        if (p.failure == 0 ? failures != 0 : failures != 1 || required != p.failure || reason != p.reason) {
            ++settlementBreaches;
        }
    }

    /// @dev `ChargedFromBalance` appears exactly once, for exactly the debit, when a vault
    ///      mandate's charge or settlement was paid from the balance, and never otherwise.
    function _auditFallbackEvent(uint256 target, uint256 delta, Pre memory p, Vm.Log[] memory logs) internal {
        uint256 seen;
        uint256 amount;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(hub) || log.topics.length < 2) continue;
            if (log.topics[0] != IMandateHub.ChargedFromBalance.selector) continue;
            if (uint256(log.topics[1]) != target) {
                ++fallbackEventMismatches;
                continue;
            }
            ++seen;
            amount = abi.decode(log.data, (uint256));
        }
        bool expected = p.succeeded && p.fromBalance && delta != 0;
        if (expected ? seen != 1 || amount != delta : seen != 0) ++fallbackEventMismatches;
    }

    /// @dev For a mandate drawn from a vault: the merchant received exactly the booked amount,
    ///      paid by the vault, and the payer's shares fell by exactly what the vault priced that
    ///      amount at before the call, and by nothing when nothing was booked or the balance paid
    ///      instead. Books a vault debit into the vault ledger, and a fallback into the ghost.
    function _auditVault(
        uint256 target,
        uint256 delta,
        Pre memory p,
        uint256[] memory afterward,
        uint256 paid,
        uint256 burned,
        uint8 reason
    ) internal {
        if (target == 0 || target > _createdIds.length) return;
        IMandateHub.Mandate memory c = _ghost[target].created;
        if (c.vault == address(0)) return;
        uint256 v = _vaultIndex(c.vault);

        uint256 m = _balanceIndex(c.merchant, c.asset);
        uint256 s = _balanceIndex(c.payer, c.vault);
        if (paid != delta || afterward[m] != p.balances[m] + delta) ++vaultPaymentBreaches;
        uint256 cost = delta == 0 ? 0 : p.shareCost;
        if (burned != cost || p.balances[s] < cost || afterward[s] != p.balances[s] - cost) ++positionBreaches;

        if (reason != 0) ++vaultChargeFailures;
        if (reason == REASON_TRANSFER_REFUSED) ++refusedSettlements;
        if (delta == 0) return;

        if (p.fromBalance) {
            ++balanceFallbacks;
            _ghost[target].fromBalance += delta;
            return;
        }
        ++vaultDebits;
        paidFromVault[c.payer][v] += delta;
        _debitLedger(c.payer, v, cost, delta);
    }

    /// @dev Take `shares` from `payer`'s expected position in vault `v` and `paid` from the
    ///      vault's expected holding. A ledger that would go negative has already been broken by
    ///      an earlier call; it is counted and clamped rather than allowed to revert the handler.
    function _debitLedger(address payer, uint256 v, uint256 shares, uint256 paid) internal {
        uint256 held = expectedShares[payer][v];
        uint256 pool = expectedVaultAssets[v];
        if (held < shares || pool < paid) ++positionBreaches;
        expectedShares[payer][v] = held < shares ? 0 : held - shares;
        expectedVaultAssets[v] = pool < paid ? 0 : pool - paid;
    }

    /// @return delta The increase in the record's `totalCharged`, zero if it did not increase.
    function _auditRecord(
        uint256 id,
        bool isTarget,
        IMandateHub.Mandate memory b,
        IMandateHub.Mandate memory a,
        Vm.Log[] memory logs
    ) internal returns (uint256 delta) {
        bool same = keccak256(abi.encode(a)) == keccak256(abi.encode(b));
        if (!_sameTerms(a, b)) ++termMutations;
        if (!same && !isTarget) ++foreignMutations;
        if (!same && b.status == IMandateHub.Status.Cancelled) ++cancelledMutations;
        if (a.totalCharged < b.totalCharged) {
            ++totalDecreases;
            return 0;
        }

        delta = a.totalCharged - b.totalCharged;
        if (delta != 0) _recordDebit(id, delta, b);
        _auditSchedule(id, delta, b, a);
        _auditEvents(id, delta, b, a, logs);
    }

    /// @dev The schedule moves only as specified. A periodic debit advances `nextChargeAt` to the
    ///      first lattice point after now, in a later period than the previous debit; a stream
    ///      debit moves the checkpoint to now; a resume shifts it by exactly the billable part of
    ///      the paused interval, the part after both the pause and the checkpoint; nothing else
    ///      moves it.
    function _auditSchedule(uint256 id, uint256 delta, IMandateHub.Mandate memory b, IMandateHub.Mandate memory a)
        internal
    {
        if (delta == 0) {
            uint256 expected = b.nextChargeAt;
            if (b.pausedAt != 0 && a.pausedAt == 0) {
                uint256 billableFrom = b.pausedAt > b.nextChargeAt ? b.pausedAt : b.nextChargeAt;
                if (block.timestamp > billableFrom) expected += block.timestamp - billableFrom;
            }
            if (a.nextChargeAt != expected) ++scheduleBreaches;
            return;
        }
        if (a.period == 0) {
            if (a.nextChargeAt != block.timestamp) ++scheduleBreaches;
            return;
        }

        Ghost storage g = _ghost[id];
        uint256 anchor = g.created.nextChargeAt;
        uint256 next = a.nextChargeAt;
        if (block.timestamp < anchor || next <= block.timestamp) {
            ++scheduleBreaches;
            return;
        }
        if (next - block.timestamp > a.period || (next - anchor) % a.period != 0) ++scheduleBreaches;

        uint256 index = (block.timestamp - anchor) / a.period;
        if (g.debits > 1 && index <= g.lastPeriodIndex) ++scheduleBreaches;
        g.lastPeriodIndex = index;
    }

    function _recordDebit(uint256 id, uint256 delta, IMandateHub.Mandate memory b) internal {
        Ghost storage g = _ghost[id];
        ++g.debits;
        if (delta > g.maxDebit) g.maxDebit = delta;
        if (g.minDebit == 0 || delta < g.minDebit) g.minDebit = delta;
        g.lastDebitAt = uint64(block.timestamp);
        ++successfulDebits;

        if (block.timestamp > b.expiresAt) ++debitsAfterExpiry;
        if (b.pausedAt != 0) ++debitsWhilePaused;
        if (delta > b.maxPerCharge) ++capBreaches;
        if (b.period != 0) {
            if (delta != b.amount || block.timestamp < b.nextChargeAt) ++capBreaches;
        } else if (block.timestamp <= b.nextChargeAt || delta > uint256(b.amount) * (block.timestamp - b.nextChargeAt))
        {
            ++capBreaches;
        }
    }

    /// @dev `Charged` must agree with the record and appear exactly once per debit. `ChargeFailed`
    ///      must leave the total and the schedule alone and leave the mandate delinquent (or
    ///      cancelled, when it came from the settlement inside a cancel).
    function _auditEvents(
        uint256 id,
        uint256 delta,
        IMandateHub.Mandate memory b,
        IMandateHub.Mandate memory a,
        Vm.Log[] memory logs
    ) internal {
        uint256 charged;
        uint256 failed;
        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter != address(hub) || log.topics.length < 2 || uint256(log.topics[1]) != id) continue;

            if (log.topics[0] == IMandateHub.Charged.selector) {
                ++charged;
                (uint256 amount, uint96 total, uint64 next) = abi.decode(log.data, (uint256, uint96, uint64));
                if (
                    amount != delta || total != a.totalCharged || next != a.nextChargeAt
                        || address(uint160(uint256(log.topics[2]))) != a.merchant
                ) ++chargedEventMismatches;
            } else if (log.topics[0] == IMandateHub.ChargeFailed.selector) {
                ++failed;
            }
        }

        if (charged != (delta == 0 ? 0 : 1)) ++chargedEventMismatches;
        if (failed != 0) {
            chargeFailures += failed;
            if (failed != 1 || delta != 0 || a.nextChargeAt != b.nextChargeAt) ++failedChargeBreaches;
            if (a.status == IMandateHub.Status.Active) ++failedChargeBreaches;
        }
    }

    /// @dev Every transfer of a watched token must be part of the acted-on mandate's pull, and
    ///      never alongside a `ChargeFailed`. For a mandate on the payer's wallet that is its asset
    ///      from its payer to its merchant. For one drawn from a vault it is its asset from that
    ///      vault to its merchant, and its payer's shares in that vault burned; its payer's wallet,
    ///      any other vault and any other holder of shares must not move. When the balance paid
    ///      for a vault mandate, it is the asset from the payer to the merchant, and the vault's
    ///      rolled-back attempt before it is skipped. Nothing is read when the logs are void.
    /// @return paid What the mandate's merchant was paid in its asset.
    /// @return burned The payer's shares burned in the mandate's vault.
    function _auditTransfers(uint256 target, Vm.Log[] memory logs, bool voided, bool fromBalance)
        internal
        returns (uint256 paid, uint256 burned)
    {
        if (voided) return (0, 0);
        bool known = target != 0 && target <= _createdIds.length;
        IMandateHub.Mandate memory c;
        if (known) c = _ghost[target].created;
        bool failed = known && _failureReason(target, logs) != 0;

        for (uint256 i = 0; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.topics.length != 3 || log.topics[0] != TRANSFER_TOPIC || !_isWatchedToken(log.emitter)) continue;

            uint8 kind = known ? _pullPart(log, c, fromBalance) : 0;
            if (kind == 3) continue;
            if (kind == 0) {
                ++strayTransfers;
                continue;
            }
            if (failed) ++failedChargeBreaches;

            uint256 value = abi.decode(log.data, (uint256));
            if (kind == 2) {
                burned += value;
            } else {
                paid += value;
                _ghost[target].receipts += value;
            }
        }
    }

    /// @dev Which part of mandate `c`'s pull a `Transfer` log is: 1 its asset reaching its
    ///      merchant from its payer (or from its vault, when it draws from one and the vault
    ///      paid), 2 its payer's shares in its vault burned, 3 the vault's rolled-back attempt
    ///      before the balance paid, 0 none of these.
    function _pullPart(Vm.Log memory log, IMandateHub.Mandate memory c, bool fromBalance)
        internal
        pure
        returns (uint8)
    {
        address from = address(uint160(uint256(log.topics[1])));
        address to = address(uint160(uint256(log.topics[2])));
        bool vaultPaid = c.vault != address(0) && !fromBalance;
        address source = vaultPaid ? c.vault : c.payer;
        if (log.emitter == c.asset && from == source && to == c.merchant) return 1;
        if (vaultPaid && log.emitter == c.vault && from == c.payer && to == address(0)) return 2;
        if (fromBalance && log.emitter == c.asset && from == c.vault && to == c.merchant) return 3;
        if (fromBalance && log.emitter == c.vault && from == c.payer && to == address(0)) return 3;
        return 0;
    }

    /// @dev Across every watched account and token, and every share supply, the only changes
    ///      are the target's pull by exactly the booked debit: the asset from the payer's wallet
    ///      to the merchant, or from the vault to the merchant with the payer's shares burned by
    ///      exactly the vault's price for the debit.
    function _auditBalances(uint256 target, uint256 delta, Pre memory p, uint256[] memory afterward) internal {
        uint256[] memory before = p.balances;
        IMandateHub.Mandate memory c;
        if (delta != 0) c = _ghost[target].created;
        address source = c.vault == address(0) || p.fromBalance ? c.payer : c.vault;

        for (uint256 a = 0; a < _accounts.length; ++a) {
            for (uint256 t = 0; t < _tokens.length; ++t) {
                uint256 k = a * _tokens.length + t;
                uint256 expected = before[k];
                if (delta != 0) {
                    address account = _accounts[a];
                    address token = _tokens[t];
                    uint256 out;
                    if (token == c.asset && account == source) out = delta;
                    else if (token == c.vault && account == c.payer) out = p.shareCost;
                    if (expected < out) {
                        ++conservationBreaches;
                        continue;
                    }
                    expected -= out;
                    if (token == c.asset && account == c.merchant) expected += delta;
                }
                if (afterward[k] != expected) ++conservationBreaches;
            }
        }

        uint256 base = _accounts.length * _tokens.length;
        for (uint256 i = 0; i < 3; ++i) {
            uint256 expected = before[base + i];
            if (delta != 0 && c.vault == address(vaults[i])) {
                if (expected < p.shareCost) {
                    ++conservationBreaches;
                    continue;
                }
                expected -= p.shareCost;
            }
            if (afterward[base + i] != expected) ++conservationBreaches;
        }
    }

    /// @dev Every watched account's balance of every watched token, then every share supply.
    function _balances() internal view returns (uint256[] memory b) {
        b = new uint256[](_accounts.length * _tokens.length + 3);
        for (uint256 a = 0; a < _accounts.length; ++a) {
            for (uint256 t = 0; t < _tokens.length; ++t) {
                b[a * _tokens.length + t] = IERC20(_tokens[t]).balanceOf(_accounts[a]);
            }
        }
        uint256 base = _accounts.length * _tokens.length;
        for (uint256 i = 0; i < 3; ++i) {
            b[base + i] = vaults[i].totalSupply();
        }
    }

    function _balanceIndex(address account, address token) internal view returns (uint256) {
        uint256 a;
        while (_accounts[a] != account) ++a;
        uint256 t;
        while (_tokens[t] != token) ++t;
        return a * _tokens.length + t;
    }

    /*//////////////////////////////////////////////////////////////
                              GHOST UPDATES
    //////////////////////////////////////////////////////////////*/

    function _onCreated(uint256 id, uint256 expectedId, address payer, IMandateHub.Terms memory t, uint64 start)
        internal
    {
        _createdIds.push(id);
        if (id != expectedId || id != _createdIds.length) ++creationMismatches;

        IMandateHub.Mandate memory m = hub.getMandate(id);
        Ghost storage g = _ghost[id];
        g.created = m;
        g.manager = t.manager;
        if (!_storedAsAgreed(m, payer, t, start)) ++creationMismatches;
        if (t.vault != address(0)) ++vaultMandates;
    }

    function _onCancelled(uint256 id) internal {
        if (id == 0 || id > _createdIds.length) return;
        Ghost storage g = _ghost[id];
        g.cancelled = true;
        g.totalAtCancel = hub.getMandate(id).totalCharged;
        ++cancels;
    }

    function _onPaused(uint256 id) internal {
        if (id == 0 || id > _createdIds.length) return;
        _ghost[id].pausedSince = uint64(block.timestamp);
        ++pauses;
    }

    function _onResumed(uint256 id) internal {
        if (id == 0 || id > _createdIds.length) return;
        Ghost storage g = _ghost[id];
        if (g.pausedSince != 0) {
            uint256 start = g.created.nextChargeAt;
            uint256 from = g.pausedSince > start ? g.pausedSince : start;
            if (block.timestamp > from) g.pausedOverlap += block.timestamp - from;
        }
        g.pausedSince = 0;
        ++resumes;
    }

    function _onManagerSet(uint256 id, address next) internal {
        if (id == 0 || id > _createdIds.length) return;
        _ghost[id].manager = next;
    }

    /*//////////////////////////////////////////////////////////////
                              ERROR MODELS
    //////////////////////////////////////////////////////////////*/

    /// @dev A vault is valid only when it is the vault over the terms' asset: a vault over another
    ///      asset, an account with no code, a token and the hub are all refused.
    function _createErrors(IMandateHub.Terms memory t) internal view returns (Expect memory x) {
        if (t.vault != address(0) && t.vault != address(_vaultOver(t.asset))) {
            _allow(x, IMandateHub.InvalidVault.selector);
        }
    }

    function _chargeErrors(uint256 id) internal view returns (Expect memory x) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (m.payer == address(0)) {
            _allow(x, IMandateHub.UnknownMandate.selector);
            return x;
        }
        if (m.status == IMandateHub.Status.Cancelled) _allow(x, IMandateHub.MandateIsCancelled.selector);
        if (block.timestamp > m.expiresAt) _allow(x, IMandateHub.MandateExpired.selector);
        if (m.pausedAt != 0) _allow(x, IMandateHub.MandateIsPaused.selector);
        if (!_isDue(m)) _allow(x, IMandateHub.NotDue.selector);
        if (!_capHasRoom(m)) _allow(x, IMandateHub.TotalCapExceeded.selector);

        // Only when every term check passes is the pull attempted. A vault that cannot pay, for
        // any reason, never reverts the charge: the balance pays or it fails. The one revert left
        // is a transfer from the payer's balance the refusable token says no to, on a direct
        // mandate or on a vault mandate's fallback.
        if (x.count == 0 && _pullsFromBalance(m, _dueAmount(m)) && _tokenRefuses(m.asset)) {
            if (refusing.mode() == RefusingToken.Mode.ReturnFalse) {
                _allow(x, SafeERC20.SafeERC20FailedOperation.selector);
            } else {
                _allow(x, ERROR_STRING);
            }
        }
    }

    function _cancelErrors(uint256 id, address by) internal view returns (Expect memory x) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (m.payer == address(0)) {
            _allow(x, IMandateHub.UnknownMandate.selector);
            return x;
        }
        if (by != m.payer && by != m.merchant && (by != m.manager || by == address(0))) {
            _allow(x, IMandateHub.NotAuthorized.selector);
        }
        if (m.status == IMandateHub.Status.Cancelled) _allow(x, IMandateHub.MandateIsCancelled.selector);
    }

    function _streamControlErrors(uint256 id, address by, bool pausing) internal view returns (Expect memory x) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (m.payer == address(0)) {
            _allow(x, IMandateHub.UnknownMandate.selector);
            return x;
        }
        if (by != m.payer && (by != m.manager || by == address(0))) _allow(x, IMandateHub.NotAuthorized.selector);
        if (m.status == IMandateHub.Status.Cancelled) _allow(x, IMandateHub.MandateIsCancelled.selector);
        if (block.timestamp > m.expiresAt) _allow(x, IMandateHub.MandateExpired.selector);
        if (m.period != 0) _allow(x, IMandateHub.NotStreaming.selector);
        if (pausing && m.pausedAt != 0) _allow(x, IMandateHub.MandateIsPaused.selector);
        if (!pausing && m.pausedAt == 0) _allow(x, IMandateHub.MandateNotPaused.selector);
    }

    function _setManagerErrors(uint256 id, address by) internal view returns (Expect memory x) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (m.payer == address(0)) {
            _allow(x, IMandateHub.UnknownMandate.selector);
            return x;
        }
        if (by != m.payer) _allow(x, IMandateHub.NotAuthorized.selector);
        if (m.status == IMandateHub.Status.Cancelled) _allow(x, IMandateHub.MandateIsCancelled.selector);
    }

    function _signatureErrors(Signed memory s) internal view {
        if (block.timestamp > s.deadline) _allow(s.expect, IMandateHub.SignatureExpired.selector);
        if (s.wrongKey) _allow(s.expect, IMandateHub.InvalidSignature.selector);
        if (nonceModel[s.signer][s.nonce]) _allow(s.expect, IMandateHub.NonceAlreadyUsed.selector);
    }

    function _succeeded(string memory label, Expect memory x) internal {
        if (x.count == 0) return;
        ++unexpectedSuccesses;
        lastUnexpected = abi.encodePacked(label, x.errors[0]);
    }

    function _reverted(Expect memory x, bytes memory err) internal {
        bytes4 selector = bytes4(err);
        for (uint256 i = 0; i < x.count; ++i) {
            if (x.errors[i] == selector) {
                ++legitReverts;
                return;
            }
        }
        _unexpected(err);
    }

    /// @dev A refused creation, where `InvalidVault` must also name the vault the terms gave.
    function _revertedCreating(Expect memory x, bytes memory err, IMandateHub.Terms memory t) internal {
        if (bytes4(err) != IMandateHub.InvalidVault.selector) {
            _reverted(x, err);
        } else if (keccak256(err) != keccak256(abi.encodeWithSelector(IMandateHub.InvalidVault.selector, t.vault))) {
            _unexpected(err);
        } else {
            _reverted(x, err);
            ++invalidVaultRefusals;
        }
    }

    function _unexpected(bytes memory err) internal {
        ++unexpectedReverts;
        lastUnexpected = err;
    }

    function _allow(Expect memory x, bytes4 selector) internal pure {
        if (x.count < x.errors.length) x.errors[x.count++] = selector;
    }

    function _allows(Expect memory x, bytes4 selector) internal pure returns (bool) {
        for (uint256 i = 0; i < x.count; ++i) {
            if (x.errors[i] == selector) return true;
        }
        return false;
    }

    function _merge(Expect memory into, Expect memory from) internal pure {
        for (uint256 i = 0; i < from.count; ++i) {
            _allow(into, from.errors[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       TERMS, ACTORS AND SIGNATURES
    //////////////////////////////////////////////////////////////*/

    function _periodicTerms(
        uint256 who,
        uint256 amountSeed,
        uint256 periodSeed,
        uint256 startSeed,
        uint256 capSeed,
        uint256 expirySeed
    ) internal view returns (IMandateHub.Terms memory t) {
        _parties(t, who);
        t.amount = uint96(bound(amountSeed, 1, 100e6));
        t.period = uint32(bound(periodSeed, 60, 30 days));
        t.startAt = _startAt(startSeed, 60 days, 30 days);
        t.maxPerCharge = uint96(bound(capSeed, t.amount, uint256(t.amount) * 2));
        t.maxTotal = uint96(bound(capSeed >> 128, t.amount, uint256(t.amount) * 4));

        uint256 start = t.startAt == 0 ? block.timestamp : t.startAt;
        uint256 floor = start > block.timestamp ? start : block.timestamp + 1;
        t.expiresAt = uint64(floor + bound(expirySeed, 0, 365 days));
    }

    function _streamTerms(
        uint256 who,
        uint256 rateSeed,
        uint256 capSeed,
        uint256 totalSeed,
        uint256 startSeed,
        uint256 expirySeed
    ) internal view returns (IMandateHub.Terms memory t) {
        _parties(t, who);
        t.amount = uint96(bound(rateSeed, 1, 1_000));
        t.period = 0;
        t.startAt = _startAt(startSeed, 60 days, 3 days);
        t.maxPerCharge = uint96(bound(capSeed, 1, 50e6));
        t.maxTotal = uint96(bound(totalSeed, 1, totalSeed % 2 == 0 ? 20e6 : 500e6));

        uint256 start = t.startAt > block.timestamp ? t.startAt : block.timestamp;
        t.expiresAt = uint64(start + bound(expirySeed, 1, 365 days));
    }

    /// @dev Merchant, asset, manager and vault from `who`; the payer is `payers[who % 3]`.
    function _parties(IMandateHub.Terms memory t, uint256 who) internal view {
        uint256 asset = (who / 6) % 3;
        t.merchant = merchants[(who / 3) % 2];
        t.asset = _assets[asset];
        t.manager = _managerChoice(who / 18);
        t.vault = _vaultChoice(asset, _h(who, 72));
        t.ref = bytes32(who);
    }

    /// @dev The payer's wallet three times in eight, the vault over the asset four times in eight,
    ///      and one time in eight something that is not a vault over it: a vault over another
    ///      asset, an account with no code, another asset's token, or the hub.
    function _vaultChoice(uint256 asset, uint256 seed) internal view returns (address) {
        uint256 k = seed % 8;
        if (k < 3) return address(0);
        if (k < 7) return address(vaults[asset]);
        uint256 j = (seed >> 8) % 4;
        if (j == 0) return address(vaults[(asset + 1) % 3]);
        if (j == 1) return stranger;
        if (j == 2) return _assets[(asset + 1) % 3];
        return address(hub);
    }

    /// @dev Zero (now), a past moment up to `back` ago, or a future one up to `ahead` out.
    function _startAt(uint256 seed, uint256 back, uint256 ahead) internal view returns (uint64) {
        uint256 mode = seed % 3;
        if (mode == 0) return 0;
        if (mode == 1) return uint64(block.timestamp - bound(seed >> 2, 1, back));
        return uint64(block.timestamp + bound(seed >> 2, 1, ahead));
    }

    function _expectedStart(IMandateHub.Terms memory t) internal view returns (uint64 start) {
        start = t.startAt == 0 ? uint64(block.timestamp) : t.startAt;
        if (t.period == 0 && start < block.timestamp) start = uint64(block.timestamp);
    }

    function _storedAsAgreed(IMandateHub.Mandate memory m, address payer, IMandateHub.Terms memory t, uint64 start)
        internal
        pure
        returns (bool)
    {
        return m.payer == payer && m.merchant == t.merchant && m.asset == t.asset && m.vault == t.vault
            && m.manager == t.manager && m.amount == t.amount && m.period == t.period
            && m.maxPerCharge == t.maxPerCharge && m.maxTotal == t.maxTotal && m.expiresAt == t.expiresAt
            && m.nextChargeAt == start && m.status == IMandateHub.Status.Active && m.totalCharged == 0
            && m.pausedAt == 0;
    }

    function _sameTerms(IMandateHub.Mandate memory a, IMandateHub.Mandate memory b) internal pure returns (bool) {
        return a.payer == b.payer && a.merchant == b.merchant && a.asset == b.asset && a.vault == b.vault
            && a.amount == b.amount && a.period == b.period && a.maxPerCharge == b.maxPerCharge
            && a.maxTotal == b.maxTotal && a.expiresAt == b.expiresAt;
    }

    /// @dev Mostly an existing id; one run in sixteen an unknown one (zero or the next id).
    ///      Rare branches key on a nonzero residue throughout, because the fuzzer favours zero.
    function _pickId(uint256 seed) internal view returns (uint256) {
        uint256 n = _createdIds.length;
        if (n == 0 || seed % 16 == 15) return seed % 32 == 15 ? 0 : n + 1;
        return seed % n + 1;
    }

    /// @dev A mandate drawn from a vault that the hub says is chargeable, searching from `seed`,
    ///      or zero when there is none.
    function _pickChargeableFromVault(uint256 seed) internal view returns (uint256) {
        uint256 n = _createdIds.length;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = (seed % n + i) % n + 1;
            if (_ghost[id].created.vault != address(0) && hub.isChargeable(id)) return id;
        }
        return 0;
    }

    /// @dev For pause and resume: seven times in eight an uncancelled stream, a paused one when
    ///      `paused` and a running one otherwise if there is one; else any id.
    function _pickStream(uint256 seed, bool paused) internal view returns (uint256) {
        uint256 n = _createdIds.length;
        if (n == 0 || seed % 8 == 7) return _pickId(seed >> 3);

        uint256 first = seed % n;
        uint256 fallbackId;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = (first + i) % n + 1;
            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (m.period != 0 || m.status == IMandateHub.Status.Cancelled) continue;
            if ((m.pausedAt != 0) == paused) return id;
            if (fallbackId == 0) fallbackId = id;
        }
        return fallbackId != 0 ? fallbackId : _pickId(seed >> 3);
    }

    /// @dev Any keyed party, relative to the mandate: its payer (three times in eight), its
    ///      manager (or payer when it has none), its merchant, another payer, a pool manager, or
    ///      the stranger. Never the zero address.
    function _actor(uint256 id, uint256 seed) internal view returns (address who) {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        uint256 k = seed % 8;
        if (k < 3) who = m.payer;
        else if (k == 3) who = m.manager != address(0) ? m.manager : m.payer;
        else if (k == 4) who = m.merchant;
        else if (k == 5) who = payers[(seed / 8) % 3];
        else if (k == 6) who = managers[(seed / 8) % 2];
        else who = stranger;
        if (who == address(0)) who = stranger;
    }

    function _anyone(uint256 seed) internal view returns (address) {
        return seed % 10 == 9 ? relayer : _accounts[seed % 10];
    }

    /// @dev No manager half the time, otherwise one of the two pool managers.
    function _managerChoice(uint256 seed) internal view returns (address) {
        uint256 k = seed % 4;
        return k < 2 ? address(0) : managers[k - 2];
    }

    /// @dev Cancel, pause and resume evenly, and an invalid code one run in four.
    function _actionCode(uint256 seed) internal pure returns (uint8) {
        uint256 k = _h(seed, 0) % 8;
        if (k < 2) return ACTION_CANCEL;
        if (k < 4) return ACTION_PAUSE;
        if (k < 6) return ACTION_RESUME;
        return k == 6 ? 0 : 4;
    }

    function _signed(address signer, uint256 keySeed, uint256 nonceSeed, uint256 deadlineSeed)
        internal
        view
        returns (Signed memory s)
    {
        s.signer = signer;
        s.nonce = _h(nonceSeed, 0) % NONCE_SPACE;
        // Expired one time in eight, exactly now (still valid: the deadline is inclusive) one in eight.
        uint256 k = _h(deadlineSeed, 0) % 8;
        s.deadline =
            k == 7 ? block.timestamp - 1 : k == 6 ? block.timestamp : block.timestamp + _h(deadlineSeed, 1) % 1 days;
        s.wrongKey = _h(keySeed, 0) % 8 == 7;
        s.key = s.wrongKey ? (signer == stranger ? _payerKeys[0] : STRANGER_KEY) : _keyOf(signer);
    }

    function _keyOf(address who) internal view returns (uint256) {
        for (uint256 i = 0; i < 3; ++i) {
            if (payers[i] == who) return _payerKeys[i];
        }
        for (uint256 i = 0; i < 2; ++i) {
            if (merchants[i] == who) return _merchantKeys[i];
            if (managers[i] == who) return _managerKeys[i];
        }
        return STRANGER_KEY;
    }

    function _createHash(address payer, IMandateHub.Terms memory t, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        // `Terms` has only static members, so its ABI encoding is its EIP-712 `encodeData`.
        bytes32 termsHash = keccak256(abi.encode(TERMS_TYPEHASH, t));
        return keccak256(abi.encode(MANDATE_TYPEHASH, payer, termsHash, nonce, deadline));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _keyed(uint256 key, string memory label) internal returns (address who) {
        who = vm.addr(key);
        vm.label(who, label);
    }

    /*//////////////////////////////////////////////////////////////
                             SMALL PREDICATES
    //////////////////////////////////////////////////////////////*/

    /// @dev What a successful charge (or, with `settlement`, the best-effort settlement inside a
    ///      successful pause or cancel) must do now. Nothing unless something is due with room
    ///      under the cap, and for a settlement only on a live, running stream. Then book the due
    ///      amount: from the vault, priced in shares, when the mandate draws from one that can pay
    ///      it; otherwise from the payer's balance when that can; otherwise report it with the
    ///      reason, the vault's for a vault mandate. A settlement whose balance transfer the token
    ///      would refuse reports reason 3; a charge in that state reverts instead.
    function _expectPull(Pre memory p, uint256 id, bool settlement) internal view {
        IMandateHub.Mandate memory m = hub.getMandate(id);
        if (m.payer == address(0) || !_isDue(m) || !_capHasRoom(m)) return;
        if (settlement) {
            if (m.period != 0 || m.pausedAt != 0) return;
            if (m.status == IMandateHub.Status.Cancelled || block.timestamp > m.expiresAt) return;
        }

        uint256 due = _dueAmount(m);
        uint8 reason;
        if (m.vault != address(0)) {
            reason = _vaultReason(m, due);
            if (reason == 0) {
                p.debit = due;
                p.shareCost = MockVault(m.vault).previewWithdraw(due);
                return;
            }
            if (_walletShortfall(m, due) != 0) {
                (p.failure, p.reason) = (due, reason);
                return;
            }
            p.fromBalance = true;
        } else {
            reason = _walletShortfall(m, due);
            if (reason != 0) {
                (p.failure, p.reason) = (due, reason);
                return;
            }
        }
        // The balance pays, unless the token refuses: then a settlement reports reason 3 and a
        // charge reverts, which `_chargeErrors` allows.
        if (_tokenRefuses(m.asset)) {
            p.fromBalance = false;
            if (settlement) (p.failure, p.reason) = (due, REASON_TRANSFER_REFUSED);
            return;
        }
        p.debit = due;
    }

    /// @dev The live mandate that becomes chargeable soonest after now, and when.
    function _soonestDue() internal view returns (uint256 soonest, uint256 at) {
        for (uint256 id = 1; id <= _createdIds.length; ++id) {
            IMandateHub.Mandate memory m = hub.getMandate(id);
            if (m.status == IMandateHub.Status.Cancelled || m.pausedAt != 0 || !_capHasRoom(m)) continue;
            uint256 due = m.period == 0 ? uint256(m.nextChargeAt) + 1 : m.nextChargeAt;
            if (due <= block.timestamp || due > m.expiresAt) continue;
            if (soonest == 0 || due < at) (soonest, at) = (id, due);
        }
    }

    function _isDue(IMandateHub.Mandate memory m) internal view returns (bool) {
        return m.period == 0 ? block.timestamp > m.nextChargeAt : block.timestamp >= m.nextChargeAt;
    }

    function _capHasRoom(IMandateHub.Mandate memory m) internal pure returns (bool) {
        return m.period == 0 ? m.totalCharged < m.maxTotal : uint256(m.totalCharged) + m.amount <= m.maxTotal;
    }

    /// @dev What a charge takes now, by the specification. Only called when due with room.
    function _dueAmount(IMandateHub.Mandate memory m) internal view returns (uint256 due) {
        if (m.period != 0) return m.amount;
        due = uint256(m.amount) * (block.timestamp - m.nextChargeAt);
        if (due > m.maxPerCharge) due = m.maxPerCharge;
        if (due > m.maxTotal - m.totalCharged) due = m.maxTotal - m.totalCharged;
    }

    /// @dev Zero when the payer's wallet can fund `amount`, else the reason it cannot: its
    ///      balance, then its allowance to the hub.
    function _walletShortfall(IMandateHub.Mandate memory m, uint256 amount) internal view returns (uint8) {
        IERC20 token = IERC20(m.asset);
        if (token.balanceOf(m.payer) < amount) return REASON_INSUFFICIENT_BALANCE;
        if (token.allowance(m.payer, address(hub)) < amount) return REASON_INSUFFICIENT_ALLOWANCE;
        return 0;
    }

    /// @dev Zero when the vault a mandate draws from can pay `amount`, else the reason it cannot:
    ///      the payer's shares, then their share allowance, each against the shares the vault
    ///      prices the amount at (never its `max*` answers, which a vault in the zero-max mode
    ///      gives as zero); then a vault that refuses a funded withdrawal, short of liquidity,
    ///      paying short, or paying over when it holds more than the amount, reason 3.
    function _vaultReason(IMandateHub.Mandate memory m, uint256 amount) internal view returns (uint8) {
        SkewedVault vault = SkewedVault(m.vault);
        uint256 shares = vault.previewWithdraw(amount);
        if (vault.balanceOf(m.payer) < shares) return REASON_INSUFFICIENT_BALANCE;
        if (vault.allowance(m.payer, address(hub)) < shares) return REASON_INSUFFICIENT_ALLOWANCE;
        if (
            vault.liquidity() < amount || vault.paysShort()
                || (vault.paysOver() && IERC20(m.asset).balanceOf(m.vault) > amount)
        ) return REASON_TRANSFER_REFUSED;
        return 0;
    }

    /// @dev Whether a pull of `amount` comes to a transfer from the payer's balance: on a direct
    ///      mandate when the wallet can fund it, on a vault mandate when the vault cannot pay and
    ///      the wallet can.
    function _pullsFromBalance(IMandateHub.Mandate memory m, uint256 amount) internal view returns (bool) {
        if (_walletShortfall(m, amount) != 0) return false;
        return m.vault == address(0) || _vaultReason(m, amount) != 0;
    }

    /// @dev The refusable token in a refusing mode: it says no to every transfer from a wallet.
    function _tokenRefuses(address asset) internal view returns (bool) {
        return asset == address(refusing) && refusing.mode() != RefusingToken.Mode.Normal;
    }

    /// @dev The reason of the `ChargeFailed` the hub emitted for `id`, or zero for none.
    function _failureReason(uint256 id, Vm.Log[] memory logs) internal view returns (uint8 reason) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isChargeFailed(logs[i], id)) (reason,) = abi.decode(logs[i].data, (uint8, uint256));
        }
    }

    function _isChargeFailed(Vm.Log memory log, uint256 id) internal view returns (bool) {
        return log.emitter == address(hub) && log.topics.length >= 2
            && log.topics[0] == IMandateHub.ChargeFailed.selector && uint256(log.topics[1]) == id;
    }

    function _isWatchedToken(address a) internal view returns (bool) {
        for (uint256 t = 0; t < _tokens.length; ++t) {
            if (_tokens[t] == a) return true;
        }
        return false;
    }

    function _vaultOver(address asset) internal view returns (SkewedVault) {
        for (uint256 i = 0; i < 3; ++i) {
            if (_assets[i] == asset) return vaults[i];
        }
        return SkewedVault(address(0));
    }

    function _vaultIndex(address vault) internal view returns (uint256 i) {
        while (address(vaults[i]) != vault) ++i;
    }

    /// @dev A second independent seed derived from one fuzzed word.
    function _h(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }
}
