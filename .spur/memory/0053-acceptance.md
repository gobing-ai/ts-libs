```gherkin
Feature: Enforce lifecycle bus propagation at EventBus API boundaries

  @core
  Scenario: Missing lifecycle propagation is rejected
    Given a TypeScript options API that declares events?: EventBus<XEvents>
    And no lifecycleBus option or constructor-injected propagation path exists
    When the lifecycle-bus-propagation rule runs
    Then it reports an actionable finding at that API boundary

  @core
  Scenario: Correct lifecycle propagation passes
    Given an events API that accepts lifecycleBus and parents its internal EventBus to it
    When the lifecycle-bus-propagation rule runs
    Then no finding is reported
```
