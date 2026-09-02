// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IMandateHub} from "./interfaces/IMandateHub.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";

/// @title MandateCharger
/// @notice Charges many mandates in one transaction, and lets a Chainlink CRE workflow do the same
///         by report. One mandate that cannot be charged never stops the rest.
/// @dev Holds nothing and decides nothing. `MandateHub.charge` is permissionless, so this contract
///      needs no authority over the hub and the hub knows nothing of it; any keeper can call
///      `chargeMany`, and a charge that lands through here is indistinguishable from a direct one.
///
///      `onReport` accepts reports only from the two CRE forwarders fixed at deployment, as
///      Chainlink's consumer guidance asks: the network's `KeystoneForwarder`, which delivers a
///      deployed workflow's DON-signed reports, and the `MockKeystoneForwarder` the CRE simulator
///      writes through. `ReportCharged` names the forwarder, so a simulated run is never mistaken
///      for the network's. Either may be zero where CRE has none. There is no owner and no setter.
contract MandateCharger is IReceiver {
    /// @notice Outcome of one mandate in a batch.
    enum Outcome {
        Charged,
        Failed,
        Reverted
    }

    /// @notice The hub every charge goes to.
    IMandateHub public immutable HUB;

    /// @notice The CRE `KeystoneForwarder` for deployed workflows, or zero for none.
    address public immutable FORWARDER;

    /// @notice The CRE `MockKeystoneForwarder` the simulator writes through, or zero for none.
    address public immutable SIMULATION_FORWARDER;

    /// @notice A charge in a batch reverted. `reason` is the revert's selector, or zero when the
    ///         revert carried none.
    event ChargeReverted(uint256 indexed mandateId, bytes4 reason);

    /// @notice A CRE report was processed.
    /// @param workflowId The workflow that produced the report, from the report metadata.
    /// @param forwarder Which forwarder delivered it: `FORWARDER` or `SIMULATION_FORWARDER`.
    event ReportCharged(bytes32 indexed workflowId, address indexed forwarder, uint256 attempted, uint256 charged);

    /// @notice `onReport` from anyone but the forwarder.
    error NotForwarder(address sender);

    /// @notice The hub address is zero.
    error InvalidHub();

    /// @param forwarder The network's CRE `KeystoneForwarder`, or zero where there is none.
    /// @param simulationForwarder The network's CRE `MockKeystoneForwarder`, or zero.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(IMandateHub hub, address forwarder, address simulationForwarder) {
        if (address(hub) == address(0)) revert InvalidHub();
        HUB = hub;
        FORWARDER = forwarder;
        SIMULATION_FORWARDER = simulationForwarder;
    }

    /// @notice Attempt a charge on every id, in order.
    /// @return outcomes One entry per id: charged, failed for funding (the hub emitted
    ///         `ChargeFailed`), or reverted (not due, cancelled, expired, capped, and so on).
    function chargeMany(uint256[] calldata mandateIds) external returns (Outcome[] memory outcomes) {
        return _chargeMany(mandateIds);
    }

    /// @inheritdoc IReceiver
    /// @dev The report is `abi.encode(uint256[] mandateIds)`.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender == address(0) || (msg.sender != FORWARDER && msg.sender != SIMULATION_FORWARDER)) {
            revert NotForwarder(msg.sender);
        }

        uint256[] memory ids = abi.decode(report, (uint256[]));
        Outcome[] memory outcomes = _chargeMany(ids);

        uint256 charged = 0;
        for (uint256 i = 0; i < outcomes.length; ++i) {
            if (outcomes[i] == Outcome.Charged) ++charged;
        }

        bytes32 workflowId = metadata.length >= 32 ? bytes32(metadata[:32]) : bytes32(0);
        // Events after the hub calls are the point: they summarise what those calls did. The
        // charger holds no state a reentrant call could misreport.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportCharged(workflowId, msg.sender, ids.length, charged);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev Calls in a loop are the purpose of a batch; the caller sizes the batch to its gas.
    function _chargeMany(uint256[] memory ids) internal returns (Outcome[] memory outcomes) {
        outcomes = new Outcome[](ids.length);

        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            // forge-lint: disable-next-line(calls-loop)
            uint96 before = HUB.getMandate(id).totalCharged;

            uint256 gasBefore = gasleft();
            // forge-lint: disable-next-line(calls-loop)
            try HUB.charge(id) {
                // A charge the payer cannot fund returns normally; only a moved total is a charge.
                // forge-lint: disable-next-line(calls-loop)
                outcomes[i] = HUB.getMandate(id).totalCharged > before ? Outcome.Charged : Outcome.Failed;
            } catch (bytes memory reason) {
                // A charge that ran out of gas, however many frames down, leaves this frame well
                // under a sixth of what it had (EIP-150; see `MandateHub._revertIfStarved`), and
                // one the hub found starved inside it says so with `InsufficientGas`. Reverting
                // the batch then, instead of recording a revert, is what makes a gas estimate for
                // the batch cover every charge in it: without it, the lowest passing limit is one
                // that starves a charge and records it as reverted.
                if (
                    gasleft() < gasBefore / 6
                        || keccak256(reason) == keccak256(abi.encodeWithSelector(IMandateHub.InsufficientGas.selector))
                ) {
                    // Reverting the whole batch is the point: see above.
                    // forge-lint: disable-next-line(require-revert-in-loop)
                    revert IMandateHub.InsufficientGas();
                }
                outcomes[i] = Outcome.Reverted;
                // forge-lint: disable-next-line(reentrancy-events)
                emit ChargeReverted(id, _selector(reason));
            }
        }
    }

    /// @dev The first four bytes of revert data, or zero when there are fewer.
    function _selector(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }
}
