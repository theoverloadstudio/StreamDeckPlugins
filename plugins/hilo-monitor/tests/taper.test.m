#define main hilo_main
#import "../hilo-midi.m"
#undef main
#include <assert.h>

int main(void) {
    int detent = unity;
    while (detent > minimumAudible) {
        const int next = buttonTarget(detent, NO, 1);
        assert(next < detent && detent - next <= 6);
        assert(buttonTarget(next, YES, 1) == detent);
        detent = next;
    }
    for (int level = minimumAudible + 1; level <= unity; level++) {
        for (int direction = -1; direction <= 1; direction += 2) {
            const BOOL up = direction > 0;
            int previous = level;
            for (int tier = 1; tier <= 3; tier++) {
                const int target = buttonTarget(level, up, tier);
                assert(target >= minimumAudible && target <= unity);
                assert((target - previous) * direction >= 0);
                assert(abs(target - level) <= (level >= unity - 20 ? 2 : 9));
                previous = target;
            }
        }
    }
    assert(buttonTarget(172, YES, 1) == 173);
    assert(buttonTarget(172, YES, 3) == 174);
    assert(buttonTarget(152, YES, 3) > buttonTarget(152, YES, 1));
    assert(buttonTarget(92, NO, 3) < buttonTarget(92, NO, 1));
    assert(buttonTarget(minimumAudible, NO, 3) == minimumGain);
    assert(buttonTarget(minimumGain, YES, 3) == minimumAudible);
    assert(holdRate(132, YES, 0.35) > holdRate(132, YES, 0.0));
    assert(holdRate(191, YES, 0.5) < holdRate(132, YES, 0.5));
    puts("Reversible detents, acceleration, range caps, Off and hold pacing passed.");
}
