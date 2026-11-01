"""Entry point of the built-in engine (scripts/build-feedback-engine.js): one frozen Python with
numpy, scipy and soundfile runs both audio pages.
    feedback-engine.exe <workDir>    Feedback Cutter (electron/feedbackcutter/feedback_bridge.py)
    feedback-engine.exe quiet-lift   Quiet Lift (electron/quietlift/quiet_lift_bridge.py)
"""
import sys

if len(sys.argv) > 1 and sys.argv[1] == "quiet-lift":
    del sys.argv[1]
    import quiet_lift_bridge
    quiet_lift_bridge.main()
else:
    import feedback_bridge
    feedback_bridge.main()
